import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  generateLaunchdPlist,
  LAUNCHD_LABEL,
  LaunchdServiceManager,
  type ProcessOptions,
  type ProcessResult,
  type ProcessRunner,
} from "../src/launchd/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("launchd service manager", () => {
  it("escapes every XML-sensitive path character in the generated plist", () => {
    const plist = generateLaunchdPlist({
      nodeExecutable: `/node/&<>"'`,
      projectRoot: `/project/&<>"'`,
      stdoutLog: `/logs/&<>"'.log`,
      stderrLog: `/logs/&<>"'.error.log`,
    });

    expect(plist).toContain("/node/&amp;&lt;&gt;&quot;&apos;");
    expect(plist).toContain("/project/&amp;&lt;&gt;&quot;&apos;/apps/cli/dist/cli.js");
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(plist).toContain("<string>--service-mode</string>");
    expect(plist).toContain("<key>StandardOutPath</key>\n    <string>/dev/null</string>");
    expect(plist).toContain("<key>StandardErrorPath</key>\n    <string>/dev/null</string>");
    expect(plist).not.toContain(`/node/&<>"'`);
  });

  it("installs idempotently with pinned paths, validation, and private permissions", async () => {
    const fixture = await createFixture();
    let loaded = false;
    const { calls, runner } = recordingRunner((executable, args) => {
      if (args[0] === "--version") {
        return success("v24.13.0\n");
      }
      if (executable === "/bin/launchctl" && args[0] === "print") {
        return loaded ? success("state = running\npid = 42\n") : missingService();
      }
      if (executable === "/bin/launchctl" && args[0] === "bootout") {
        loaded = false;
      }
      if (executable === "/bin/launchctl" && args[0] === "bootstrap") {
        loaded = true;
      }
      return success();
    });
    const manager = fixture.manager(runner);

    await expect(manager.install()).resolves.toContain("installed and started");
    await expect(manager.install()).resolves.toContain("installed and started");

    const plistPath = fixture.plistPath;
    const plist = await readFile(plistPath, "utf8");
    expect(plist).toContain(`<string>${fixture.nodeExecutable}</string>`);
    expect(plist).toContain(`<string>${fixture.projectRoot}/apps/cli/dist/cli.js</string>`);
    expect(plist).toContain(`<string>${fixture.projectRoot}</string>`);
    expect(plist).not.toContain("CALSYNC_TEST_SECRET");
    expect((await stat(plistPath)).mode & 0o777).toBe(0o600);
    expect((await stat(fixture.logDirectory)).mode & 0o777).toBe(0o700);

    expect(commands(calls)).toEqual([
      `${fixture.nodeExecutable} --version`,
      "npm run build",
      expect.stringMatching(/^\/usr\/bin\/plutil -lint .+\.tmp-/u),
      "/bin/launchctl bootout gui/501/com.local.calsync",
      `/bin/launchctl bootstrap gui/501 ${plistPath}`,
      `${fixture.nodeExecutable} --version`,
      "npm run build",
      expect.stringMatching(/^\/usr\/bin\/plutil -lint .+\.tmp-/u),
      "/bin/launchctl bootout gui/501/com.local.calsync",
      `/bin/launchctl bootstrap gui/501 ${plistPath}`,
    ]);
    expect(calls.find((call) => call.args[0] === "run")?.options).toMatchObject({
      cwd: fixture.projectRoot,
      stdio: "inherit",
    });
  });

  it("treats launchd bootstrap error 5 as success when the new CLI is already loaded", async () => {
    const fixture = await createFixture();
    const expectedCli = `${fixture.projectRoot}/apps/cli/dist/cli.js`;
    const { calls, runner } = recordingRunner((executable, args) => {
      if (args[0] === "--version") {
        return success("v24.13.0\n");
      }
      if (executable === "/bin/launchctl" && args[0] === "print") {
        return loadedService(expectedCli);
      }
      if (executable === "/bin/launchctl" && args[0] === "bootstrap") {
        return bootstrapEio();
      }
      return success();
    });

    await expect(fixture.manager(runner).install()).resolves.toContain("installed and started");

    expect(commands(calls).filter((command) => command.includes("bootstrap"))).toHaveLength(1);
    expect(commands(calls).filter((command) => command.includes("bootout"))).toHaveLength(1);
    expect(commands(calls)).toContain("/bin/launchctl print gui/501/com.local.calsync");
  });

  it("retries bootout and bootstrap when error 5 leaves the agent unloaded", async () => {
    const fixture = await createFixture();
    let bootstraps = 0;
    const { calls, runner } = recordingRunner((executable, args) => {
      if (args[0] === "--version") {
        return success("v24.13.0\n");
      }
      if (executable === "/bin/launchctl" && args[0] === "print") {
        return missingService();
      }
      if (executable === "/bin/launchctl" && args[0] === "bootstrap") {
        bootstraps += 1;
        return bootstraps === 1 ? bootstrapEio() : success();
      }
      return success();
    });

    await expect(fixture.manager(runner).install()).resolves.toContain("installed and started");

    expect(commands(calls).filter((command) => command.includes("bootstrap"))).toHaveLength(2);
    expect(commands(calls).filter((command) => command.includes("bootout"))).toHaveLength(2);
  });

  it("omits launchctl's run-as-root hint when bootstrap error 5 persists", async () => {
    const fixture = await createFixture();
    const { runner } = recordingRunner((executable, args) => {
      if (args[0] === "--version") {
        return success("v24.13.0\n");
      }
      if (executable === "/bin/launchctl" && args[0] === "print") {
        return missingService();
      }
      if (executable === "/bin/launchctl" && args[0] === "bootstrap") {
        return bootstrapEio();
      }
      return success();
    });

    const error = await fixture
      .manager(runner)
      .install()
      .then(
        () => {
          throw new Error("expected install to fail");
        },
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toMatch(/Input\/output error/u);
    expect(message).toContain("node apps/cli/dist/cli.js service install");
    expect(message).not.toMatch(/as root/iu);
  });

  it("constructs idempotent lifecycle commands for stopped and running states", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDirectory, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(fixture.plistPath, "installed");
    let loaded = false;
    const { calls, runner } = recordingRunner((executable, args) => {
      if (executable === "/bin/launchctl" && args[0] === "print") {
        return loaded ? success("state = running\npid = 987\n") : missingService();
      }
      if (args[0] === "bootstrap") {
        loaded = true;
      }
      if (args[0] === "bootout") {
        loaded = false;
      }
      return success();
    });
    const manager = fixture.manager(runner);

    await expect(manager.status()).resolves.toContain("installed but stopped");
    await expect(manager.start()).resolves.toBe("calsync service started.");
    await expect(manager.start()).resolves.toContain("already loaded");
    await expect(manager.status()).resolves.toContain("PID 987");
    await expect(manager.restart()).resolves.toBe("calsync service restarted.");
    await expect(manager.stop()).resolves.toContain("plist remains installed");
    await expect(manager.stop()).resolves.toContain("already stopped");

    expect(commands(calls)).toContain(`/bin/launchctl bootstrap gui/501 ${fixture.plistPath}`);
    expect(commands(calls)).toContain("/bin/launchctl kickstart -k gui/501/com.local.calsync");
    expect(commands(calls)).toContain("/bin/launchctl bootout gui/501/com.local.calsync");
  });

  it("loads a stopped service on restart and reports a missing installation clearly", async () => {
    const fixture = await createFixture();
    const { runner } = recordingRunner((_executable, args) =>
      args[0] === "print" ? missingService() : success(),
    );
    const manager = fixture.manager(runner);

    await expect(manager.start()).rejects.toThrow("service is not installed");
    await expect(manager.restart()).rejects.toThrow("service is not installed");
    await expect(manager.stop()).resolves.toContain("not installed");

    await mkdir(join(fixture.homeDirectory, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(fixture.plistPath, "installed");
    await expect(manager.restart()).resolves.toContain("now started");
  });

  it("tails the current app-managed log with line and follow options", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.logDirectory, { recursive: true });
    await writeFile(join(fixture.logDirectory, "calsync.log"), "privacy-safe output\n");
    await writeFile(join(fixture.logDirectory, "calsync.error.log"), "privacy-safe error\n");
    const { calls, runner } = recordingRunner(() => success("", 130, "SIGINT"));

    await expect(fixture.manager(runner).logs({ follow: true, lines: 25 })).resolves.toBe("");

    expect(commands(calls)).toEqual([`/usr/bin/tail -n 25 -F ${fixture.logDirectory}/calsync.log`]);
    expect(calls[0]?.options).toEqual({ stdio: "inherit" });
  });

  it("preserves all user data when uninstalling and is idempotent", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDirectory, "Library", "LaunchAgents"), { recursive: true });
    await mkdir(fixture.logDirectory, { recursive: true });
    await writeFile(fixture.plistPath, "installed");
    const database = join(fixture.homeDirectory, "calsync.sqlite");
    const log = join(fixture.logDirectory, "calsync.log");
    await writeFile(database, "state");
    await writeFile(log, "logs");
    let loaded = true;
    const { calls, runner } = recordingRunner((_executable, args) => {
      if (args[0] === "print") {
        return loaded ? success("state = running\n") : missingService();
      }
      if (args[0] === "bootout") {
        loaded = false;
      }
      return success();
    });
    const manager = fixture.manager(runner);

    const first = await manager.uninstall();
    const second = await manager.uninstall();

    expect(first).toContain("OAuth tokens, SQLite state, logs, .env");
    expect(first).toContain("managed calendar events were preserved");
    expect(second).toContain("was not installed");
    await expect(stat(fixture.plistPath)).rejects.toThrow();
    await expect(readFile(fixture.environment, "utf8")).resolves.toBe(
      "CALSYNC_TEST_SECRET=never-copy-this\n",
    );
    await expect(readFile(database, "utf8")).resolves.toBe("state");
    await expect(readFile(log, "utf8")).resolves.toBe("logs");
    expect(commands(calls).filter((command) => command.includes("bootout"))).toHaveLength(1);
  });

  it("reports platform, runtime, config, plist, and launchctl failures actionably", async () => {
    const fixture = await createFixture();
    const { runner: successRunner } = recordingRunner((_executable, args) =>
      args[0] === "--version" ? success("v24.13.0\n") : missingService(),
    );

    await expect(fixture.manager(successRunner, { platform: "linux" }).status()).rejects.toThrow(
      "requires macOS launchd",
    );
    await expect(
      fixture.manager(successRunner, { nodeVersion: "v22.0.0" }).install(),
    ).rejects.toThrow("requires Node.js 24");

    await rm(fixture.environment);
    await expect(fixture.manager(successRunner).install()).rejects.toThrow("Missing");

    await writeFile(fixture.environment, "restored");
    await rm(join(fixture.projectRoot, "apps", "cli", "dist", "cli.js"));
    const { runner: buildRunner } = recordingRunner((_executable, args) =>
      args[0] === "--version" ? success("v24.13.0\n") : success(),
    );
    await expect(fixture.manager(buildRunner).install()).rejects.toThrow("Missing built CLI at");

    await writeFile(join(fixture.projectRoot, "apps", "cli", "dist", "cli.js"), "");
    await mkdir(join(fixture.homeDirectory, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(fixture.plistPath, "previous valid plist");
    const { runner: invalidPlistRunner } = recordingRunner((executable, args) => {
      if (args[0] === "--version") {
        return success("v24.13.0\n");
      }
      if (executable === "/usr/bin/plutil") {
        return failure("unexpected XML");
      }
      return success();
    });
    await expect(fixture.manager(invalidPlistRunner).install()).rejects.toThrow(
      "plist is invalid: unexpected XML",
    );
    await expect(readFile(fixture.plistPath, "utf8")).resolves.toBe("previous valid plist");

    const { runner: launchctlFailureRunner } = recordingRunner(() =>
      failure("Operation not permitted"),
    );
    await expect(fixture.manager(launchctlFailureRunner).status()).rejects.toThrow(
      "Could not query calsync service state with launchctl: Operation not permitted",
    );

    const { runner: spawnFailureRunner } = recordingRunner(() =>
      Promise.reject(new Error("spawn launchctl ENOENT")),
    );
    await expect(fixture.manager(spawnFailureRunner).status()).rejects.toThrow(
      "Could not launch launchctl to query calsync service state: spawn launchctl ENOENT",
    );
  });
});

interface Fixture {
  homeDirectory: string;
  projectRoot: string;
  nodeExecutable: string;
  environment: string;
  plistPath: string;
  logDirectory: string;
  manager: (
    runner: ProcessRunner,
    overrides?: { platform?: NodeJS.Platform; nodeVersion?: string },
  ) => LaunchdServiceManager;
}

async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "calsync-launchd-")));
  temporaryDirectories.push(root);
  const homeDirectory = join(root, "home");
  const projectRoot = join(root, "project");
  const nodeExecutable = join(root, "node");
  const environment = join(projectRoot, ".env");
  const logDirectory = join(homeDirectory, "Library", "Logs", "calsync");
  const plistPath = join(homeDirectory, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  await mkdir(join(projectRoot, "apps", "cli", "src"), { recursive: true });
  await mkdir(join(projectRoot, "apps", "cli", "dist"), { recursive: true });
  await mkdir(homeDirectory, { recursive: true });
  await writeFile(nodeExecutable, "#!/bin/sh\n");
  await chmod(nodeExecutable, 0o700);
  await writeFile(environment, "CALSYNC_TEST_SECRET=never-copy-this\n");
  await writeFile(join(projectRoot, "package.json"), "{}");
  await writeFile(join(projectRoot, "apps", "cli", "src", "cli.ts"), "");
  await writeFile(join(projectRoot, "apps", "cli", "dist", "cli.js"), "");

  return {
    homeDirectory,
    projectRoot,
    nodeExecutable,
    environment,
    plistPath,
    logDirectory,
    manager: (runner, overrides = {}) =>
      new LaunchdServiceManager({
        platform: overrides.platform ?? "darwin",
        uid: 501,
        homeDirectory,
        projectRoot,
        nodeExecutable,
        nodeVersion: overrides.nodeVersion ?? "v24.13.0",
        npmExecutable: "npm",
        runner,
        sleep: () => Promise.resolve(),
      }),
  };
}

interface RecordedCall {
  executable: string;
  args: readonly string[];
  options?: ProcessOptions;
}

function recordingRunner(
  handler: (
    executable: string,
    args: readonly string[],
    options?: ProcessOptions,
  ) => ProcessResult | Promise<ProcessResult>,
): { calls: RecordedCall[]; runner: ProcessRunner } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    runner: async (executable, args, options) => {
      calls.push({ executable, args, ...(options === undefined ? {} : { options }) });
      return await Promise.resolve(handler(executable, args, options));
    },
  };
}

function commands(calls: readonly RecordedCall[]): string[] {
  return calls.map((call) => [call.executable, ...call.args].join(" "));
}

function success(stdout = "", exitCode = 0, signal?: NodeJS.Signals): ProcessResult {
  return { exitCode, stdout, stderr: "", ...(signal === undefined ? {} : { signal }) };
}

function failure(stderr: string, exitCode = 1): ProcessResult {
  return { exitCode, stdout: "", stderr };
}

function bootstrapEio(): ProcessResult {
  return failure(
    "Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.",
    5,
  );
}

function loadedService(cli: string): ProcessResult {
  return success(`state = running\npid = 42\narguments = {\n\t${cli}\n}\n`);
}

function missingService(): ProcessResult {
  return failure(`Could not find service "${LAUNCHD_LABEL}"`);
}
