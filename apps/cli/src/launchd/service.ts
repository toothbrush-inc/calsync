import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const LAUNCHD_LABEL = "com.local.calsync";

const UNLOAD_WAIT_ATTEMPTS = 20;
const UNLOAD_WAIT_MS = 100;

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "pipe" | "inherit";
}

export type ProcessRunner = (
  executable: string,
  args: readonly string[],
  options?: ProcessOptions,
) => Promise<ProcessResult>;

export interface LaunchdService {
  install(): Promise<string>;
  start(): Promise<string>;
  stop(): Promise<string>;
  restart(): Promise<string>;
  status(): Promise<string>;
  logs(options: { follow: boolean; lines: number }): Promise<string>;
  uninstall(): Promise<string>;
}

export interface LaunchdServiceOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  homeDirectory?: string;
  projectRoot?: string;
  nodeExecutable?: string;
  nodeVersion?: string;
  npmExecutable?: string;
  runner?: ProcessRunner;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ServicePaths {
  projectRoot: string;
  environment: string;
  cli: string;
  sourceCli: string;
  packageJson: string;
  launchAgents: string;
  plist: string;
  logDirectory: string;
  stdoutLog: string;
  stderrLog: string;
}

interface ServiceState {
  loaded: boolean;
  detail?: string;
}

export class LaunchdServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchdServiceError";
  }
}

export class LaunchdServiceManager implements LaunchdService {
  readonly #platform: NodeJS.Platform;
  readonly #uid: number;
  readonly #homeDirectory: string;
  readonly #configuredProjectRoot: string;
  readonly #configuredNodeExecutable: string;
  readonly #nodeVersion: string;
  readonly #npmExecutable: string;
  readonly #runner: ProcessRunner;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: LaunchdServiceOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#uid = options.uid ?? process.getuid?.() ?? -1;
    this.#homeDirectory = options.homeDirectory ?? process.env["HOME"] ?? "";
    this.#configuredProjectRoot = options.projectRoot ?? defaultProjectRoot();
    this.#configuredNodeExecutable = options.nodeExecutable ?? process.execPath;
    this.#nodeVersion = options.nodeVersion ?? process.version;
    this.#npmExecutable = options.npmExecutable ?? "npm";
    this.#runner = options.runner ?? runProcess;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async install(): Promise<string> {
    this.#assertMacOs();
    const paths = await this.#resolvePaths();
    const nodeExecutable = await this.#verifyNodeExecutable();
    await this.#requireFile(
      paths.environment,
      `Missing ${paths.environment}. Create it from .env.example and configure calsync before installing the service.`,
    );

    const sourceCheckout =
      (await pathIsFile(paths.packageJson)) && (await pathIsFile(paths.sourceCli));
    if (sourceCheckout) {
      const build = await this.#execute(
        this.#npmExecutable,
        ["run", "build"],
        {
          cwd: paths.projectRoot,
          env: process.env,
          stdio: "inherit",
        },
        `Could not run "${this.#npmExecutable} run build" in ${paths.projectRoot}`,
      );
      if (build.exitCode !== 0) {
        throw new LaunchdServiceError(
          `Build failed while running "${this.#npmExecutable} run build" in ${paths.projectRoot}. Fix the build errors and retry service install.`,
        );
      }
    }

    await this.#requireFile(
      paths.cli,
      `Missing built CLI at ${paths.cli}. Run "npm run build" with Node.js 24, then retry service install.`,
    );

    await mkdir(paths.logDirectory, { recursive: true, mode: 0o700 });
    await chmod(paths.logDirectory, 0o700);
    await mkdir(paths.launchAgents, { recursive: true, mode: 0o700 });

    const plist = generateLaunchdPlist({
      nodeExecutable,
      projectRoot: paths.projectRoot,
      stdoutLog: paths.stdoutLog,
      stderrLog: paths.stderrLog,
    });
    const temporaryPlist = `${paths.plist}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
    await writeFile(temporaryPlist, plist, { encoding: "utf8", mode: 0o600 });

    try {
      const validation = await this.#execute(
        "/usr/bin/plutil",
        ["-lint", temporaryPlist],
        undefined,
        "Could not run plutil to validate the generated LaunchAgent",
      );
      if (validation.exitCode !== 0) {
        throw new LaunchdServiceError(
          `Generated LaunchAgent plist is invalid: ${formatFailure(validation)}. The existing service file was not replaced.`,
        );
      }

      await rename(temporaryPlist, paths.plist);
      await chmod(paths.plist, 0o600);
      await this.#reloadAgent(
        paths.plist,
        paths.cli,
        `The plist was installed at ${paths.plist}, but launchd could not bootstrap it`,
      );
    } finally {
      await rm(temporaryPlist, { force: true });
    }

    return [
      "calsync service installed and started.",
      `Plist: ${paths.plist}`,
      `Logs: ${paths.logDirectory}`,
      `Runtime: ${nodeExecutable} (${this.#nodeVersion})`,
    ].join("\n");
  }

  async start(): Promise<string> {
    this.#assertMacOs();
    const state = await this.#getState();
    if (state.loaded) {
      return "calsync service is already loaded; launchd is managing it.";
    }

    const paths = await this.#resolvePaths();
    if (!(await pathIsFile(paths.plist))) {
      throw new LaunchdServiceError(
        'calsync service is not installed. Run "calsync service install" first.',
      );
    }
    await this.#bootstrapAgent(paths.plist, paths.cli, "Could not start the calsync service");
    return "calsync service started.";
  }

  async stop(): Promise<string> {
    this.#assertMacOs();
    const state = await this.#getState();
    const paths = await this.#resolvePaths();
    if (!state.loaded) {
      return (await pathIsFile(paths.plist))
        ? "calsync service is already stopped."
        : 'calsync service is not installed. Run "calsync service install" first.';
    }

    await this.#runLaunchctl(
      ["bootout", this.#serviceTarget],
      "Could not stop the calsync service",
    );
    return "calsync service stopped. Its plist remains installed.";
  }

  async restart(): Promise<string> {
    this.#assertMacOs();
    const state = await this.#getState();
    if (state.loaded) {
      await this.#runLaunchctl(
        ["kickstart", "-k", this.#serviceTarget],
        "Could not restart the calsync service",
      );
      return "calsync service restarted.";
    }

    const paths = await this.#resolvePaths();
    if (!(await pathIsFile(paths.plist))) {
      throw new LaunchdServiceError(
        'calsync service is not installed. Run "calsync service install" first.',
      );
    }
    await this.#bootstrapAgent(
      paths.plist,
      paths.cli,
      "Could not start the stopped calsync service",
    );
    return "calsync service was stopped and is now started.";
  }

  async status(): Promise<string> {
    this.#assertMacOs();
    const state = await this.#getState();
    const paths = await this.#resolvePaths();
    if (!state.loaded) {
      return (await pathIsFile(paths.plist))
        ? `calsync service is installed but stopped.\nPlist: ${paths.plist}`
        : 'calsync service is not installed. Run "calsync service install".';
    }

    const stateMatch = /\bstate = ([^\n]+)/u.exec(state.detail ?? "");
    const pidMatch = /\bpid = (\d+)/u.exec(state.detail ?? "");
    const launchdState = stateMatch?.[1]?.trim();
    const pid = pidMatch?.[1];
    const summary =
      pid === undefined
        ? `calsync service is loaded${launchdState === undefined ? "." : ` (launchd state: ${launchdState}).`}`
        : `calsync service is running (PID ${pid}).`;
    return `${summary}\nPlist: ${paths.plist}\nLogs: ${paths.logDirectory}`;
  }

  async logs(options: { follow: boolean; lines: number }): Promise<string> {
    this.#assertMacOs();
    if (!Number.isSafeInteger(options.lines) || options.lines < 1) {
      throw new LaunchdServiceError("Log line count must be a positive integer.");
    }
    const paths = await this.#resolvePaths();
    const files = [];
    if (await pathIsFile(paths.stdoutLog)) {
      files.push(paths.stdoutLog);
    }
    if (files.length === 0) {
      return `No calsync service logs exist yet in ${paths.logDirectory}.`;
    }

    const args = ["-n", String(options.lines), ...(options.follow ? ["-F"] : []), ...files];
    const result = await this.#execute(
      "/usr/bin/tail",
      args,
      { stdio: "inherit" },
      "Could not launch tail for the calsync service logs",
    );
    if (result.exitCode !== 0 && result.exitCode !== 130 && result.signal !== "SIGINT") {
      throw new LaunchdServiceError(
        `Could not read calsync service logs: ${formatFailure(result)}.`,
      );
    }
    return options.follow ? "" : `Displayed the last ${String(options.lines)} log lines.`;
  }

  async uninstall(): Promise<string> {
    this.#assertMacOs();
    const state = await this.#getState();
    const paths = await this.#resolvePaths();
    if (state.loaded) {
      await this.#runLaunchctl(
        ["bootout", this.#serviceTarget],
        "Could not stop the calsync service during uninstall",
      );
    }

    const wasInstalled = await pathIsFile(paths.plist);
    if (wasInstalled) {
      await unlink(paths.plist);
    }

    const summary = wasInstalled
      ? "calsync service uninstalled; its LaunchAgent plist was removed."
      : "calsync service was not installed; no plist was removed.";
    return [
      summary,
      "OAuth tokens, SQLite state, logs, .env, and managed calendar events were preserved.",
      'To remove managed events, run "calsync cleanup" before uninstalling. To remove OAuth tokens, run "calsync logout".',
    ].join("\n");
  }

  get #domainTarget(): string {
    return `gui/${String(this.#uid)}`;
  }

  get #serviceTarget(): string {
    return `${this.#domainTarget}/${LAUNCHD_LABEL}`;
  }

  #assertMacOs(): void {
    if (this.#platform !== "darwin") {
      throw new LaunchdServiceError(
        `calsync service management requires macOS launchd; this system reports ${this.#platform}. Run "calsync start" directly on other systems.`,
      );
    }
    if (this.#uid < 0) {
      throw new LaunchdServiceError(
        "Could not determine the current user ID required for the launchd GUI domain.",
      );
    }
    if (this.#homeDirectory === "") {
      throw new LaunchdServiceError("Could not determine your home directory. Set HOME and retry.");
    }
  }

  async #resolvePaths(): Promise<ServicePaths> {
    let projectRoot: string;
    try {
      projectRoot = await realpath(resolve(this.#configuredProjectRoot));
    } catch (error) {
      throw new LaunchdServiceError(
        `Could not resolve the calsync project root ${this.#configuredProjectRoot}: ${errorMessage(error)}.`,
      );
    }
    const launchAgents = join(this.#homeDirectory, "Library", "LaunchAgents");
    const logDirectory = join(this.#homeDirectory, "Library", "Logs", "calsync");
    return {
      projectRoot,
      environment: join(projectRoot, ".env"),
      cli: join(projectRoot, "apps", "cli", "dist", "cli.js"),
      sourceCli: join(projectRoot, "apps", "cli", "src", "cli.ts"),
      packageJson: join(projectRoot, "package.json"),
      launchAgents,
      plist: join(launchAgents, `${LAUNCHD_LABEL}.plist`),
      logDirectory,
      stdoutLog: join(logDirectory, "calsync.log"),
      stderrLog: join(logDirectory, "calsync.error.log"),
    };
  }

  async #verifyNodeExecutable(): Promise<string> {
    if (!isAbsolute(this.#configuredNodeExecutable)) {
      throw new LaunchdServiceError(
        `The current Node executable is not an absolute path: ${this.#configuredNodeExecutable}. Activate Node.js 24 and retry.`,
      );
    }
    const major = /^v?(\d+)\./u.exec(this.#nodeVersion)?.[1];
    if (major !== "24") {
      throw new LaunchdServiceError(
        `calsync requires Node.js 24, but the current runtime is ${this.#nodeVersion}. Run "nvm use" and retry.`,
      );
    }

    let executable: string;
    try {
      executable = await realpath(this.#configuredNodeExecutable);
      await access(executable, fsConstants.X_OK);
    } catch (error) {
      throw new LaunchdServiceError(
        `The current Node executable is unavailable or not executable at ${this.#configuredNodeExecutable}: ${errorMessage(error)}.`,
      );
    }
    const check = await this.#execute(
      executable,
      ["--version"],
      undefined,
      `Could not launch the selected Node executable ${executable}`,
    );
    if (check.exitCode !== 0) {
      throw new LaunchdServiceError(
        `Could not run the selected Node executable ${executable}: ${formatFailure(check)}.`,
      );
    }
    if (check.stdout.trim() !== this.#nodeVersion) {
      throw new LaunchdServiceError(
        `Node runtime mismatch: calsync is running as ${this.#nodeVersion}, but ${executable} reports ${check.stdout.trim() || "no version"}. Activate Node.js 24 and retry.`,
      );
    }
    return executable;
  }

  async #requireFile(path: string, message: string): Promise<void> {
    if (!(await pathIsFile(path))) {
      throw new LaunchdServiceError(message);
    }
  }

  async #getState(): Promise<ServiceState> {
    const result = await this.#execute(
      "/bin/launchctl",
      ["print", this.#serviceTarget],
      undefined,
      "Could not launch launchctl to query calsync service state",
    );
    if (result.exitCode === 0) {
      return { loaded: true, detail: result.stdout };
    }
    if (isMissingService(result)) {
      return { loaded: false };
    }
    throw new LaunchdServiceError(
      `Could not query calsync service state with launchctl: ${formatFailure(result)}.`,
    );
  }

  async #runLaunchctl(args: readonly string[], context: string): Promise<void> {
    const result = await this.#execute(
      "/bin/launchctl",
      args,
      undefined,
      `${context} because launchctl could not be launched`,
    );
    if (result.exitCode !== 0) {
      throw new LaunchdServiceError(`${context}: ${formatFailure(result)}.`);
    }
  }

  async #reloadAgent(plistPath: string, expectedCli: string, context: string): Promise<void> {
    await this.#bootoutIfPresent();
    await this.#bootstrapAgent(plistPath, expectedCli, context);
  }

  async #bootstrapAgent(plistPath: string, expectedCli: string, context: string): Promise<void> {
    const first = await this.#bootstrapOnce(plistPath, context);
    if (first.exitCode === 0 || (await this.#loadedWithCli(expectedCli))) {
      return;
    }
    if (!isBootstrapCollision(first)) {
      throw new LaunchdServiceError(`${context}: ${formatFailure(first)}.`);
    }

    await this.#bootoutIfPresent();
    await this.#waitUntilUnloaded(expectedCli);
    if (await this.#loadedWithCli(expectedCli)) {
      return;
    }

    const second = await this.#bootstrapOnce(plistPath, context);
    if (second.exitCode === 0 || (await this.#loadedWithCli(expectedCli))) {
      return;
    }
    throw new LaunchdServiceError(
      `${context}: ${formatFailure(second)}. Wait a few seconds and retry "node apps/cli/dist/cli.js service install".`,
    );
  }

  async #bootoutIfPresent(): Promise<void> {
    const result = await this.#execute(
      "/bin/launchctl",
      ["bootout", this.#serviceTarget],
      undefined,
      "Could not unload the existing calsync service before updating it because launchctl could not be launched",
    );
    if (result.exitCode === 0 || isAlreadyUnloaded(result)) {
      return;
    }
    await this.#waitUntilUnloaded();
    if (!(await this.#getState()).loaded) {
      return;
    }
    throw new LaunchdServiceError(
      `Could not unload the existing calsync service before updating it: ${formatFailure(result)}.`,
    );
  }

  async #bootstrapOnce(plistPath: string, context: string): Promise<ProcessResult> {
    return await this.#execute(
      "/bin/launchctl",
      ["bootstrap", this.#domainTarget, plistPath],
      undefined,
      `${context} because launchctl could not be launched`,
    );
  }

  async #loadedWithCli(expectedCli: string): Promise<boolean> {
    const state = await this.#getState();
    return state.loaded && cliIsLoaded(state, expectedCli);
  }

  async #waitUntilUnloaded(expectedCli?: string): Promise<void> {
    for (let attempt = 0; attempt < UNLOAD_WAIT_ATTEMPTS; attempt += 1) {
      const state = await this.#getState();
      if (!state.loaded) {
        return;
      }
      if (expectedCli !== undefined && cliIsLoaded(state, expectedCli)) {
        return;
      }
      await this.#sleep(UNLOAD_WAIT_MS);
    }
  }

  async #execute(
    executable: string,
    args: readonly string[],
    options: ProcessOptions | undefined,
    context: string,
  ): Promise<ProcessResult> {
    try {
      return await this.#runner(executable, args, options);
    } catch (error) {
      throw new LaunchdServiceError(`${context}: ${errorMessage(error)}.`);
    }
  }
}

export function generateLaunchdPlist(values: {
  nodeExecutable: string;
  projectRoot: string;
  stdoutLog: string;
  stderrLog: string;
}): string {
  const nodeExecutable = escapeXml(values.nodeExecutable);
  const projectRoot = escapeXml(values.projectRoot);
  const cli = escapeXml(join(values.projectRoot, "apps", "cli", "dist", "cli.js"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${nodeExecutable}</string>
      <string>${cli}</string>
      <string>start</string>
      <string>--service-mode</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>NODE_ENV</key>
      <string>production</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
  </dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function defaultProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isMissingService(result: ProcessResult): boolean {
  return /could not find|not found|no such process|unknown service|service cannot be found/iu.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

function isAlreadyUnloaded(result: ProcessResult): boolean {
  return result.exitCode === 3 || isMissingService(result);
}

function isBootstrapCollision(result: ProcessResult): boolean {
  if (result.exitCode === 5) {
    return true;
  }
  return /Bootstrap failed: 5\b|Input\/output error/iu.test(`${result.stdout}\n${result.stderr}`);
}

function cliIsLoaded(state: ServiceState, expectedCli: string): boolean {
  return state.detail?.includes(expectedCli) === true;
}

function formatFailure(result: ProcessResult): string {
  const detail = stripPrivilegedLaunchctlHint(result.stderr.trim() || result.stdout.trim());
  return detail === "" ? `command exited with status ${String(result.exitCode)}` : detail;
}

function stripPrivilegedLaunchctlHint(text: string): string {
  return text.replace(/\s*Try re-running the command as root for richer errors\.?/giu, "").trim();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runProcess(
  executable: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return await new Promise((resolveResult, reject) => {
    const inherited = options.stdio === "inherit";
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: inherited ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (!inherited) {
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveResult({
        exitCode: code ?? (signal === "SIGINT" ? 130 : 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(signal === null ? {} : { signal }),
      });
    });
  });
}
