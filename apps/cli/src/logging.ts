import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RotatingLogOptions {
  maxBytes: number;
  backups: number;
}

export function serviceLogPath(
  homeDirectory = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env["CALSYNC_LOG_PATH"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return join(homeDirectory, "Library", "Logs", "calsync", "calsync.log");
}

export class RotatingFileLogger {
  constructor(
    readonly path: string,
    private readonly options: RotatingLogOptions,
  ) {
    validateOptions(options);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
  }

  write(line: string): void {
    const record = `${line.replaceAll(/[\r\n]+$/gu, "")}\n`;
    const bytes = Buffer.byteLength(record);
    if (fileSize(this.path) > 0 && fileSize(this.path) + bytes > this.options.maxBytes) {
      this.rotate();
    }
    appendFileSync(this.path, record, { encoding: "utf8", mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  private rotate(): void {
    rmSync(`${this.path}.${String(this.options.backups)}`, { force: true });
    for (let index = this.options.backups - 1; index >= 1; index -= 1) {
      const source = `${this.path}.${String(index)}`;
      if (fileSize(source) > 0) {
        renameSync(source, `${this.path}.${String(index + 1)}`);
      }
    }
    if (fileSize(this.path) > 0) {
      renameSync(this.path, `${this.path}.1`);
    }
  }
}

function validateOptions(options: RotatingLogOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1_024) {
    throw new Error("Log maximum size must be an integer of at least 1024 bytes");
  }
  if (!Number.isSafeInteger(options.backups) || options.backups < 1 || options.backups > 100) {
    throw new Error("Log backup count must be an integer from 1 through 100");
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}
