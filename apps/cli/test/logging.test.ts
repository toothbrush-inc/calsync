import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RotatingFileLogger } from "../src/logging.js";

describe("RotatingFileLogger", () => {
  it("rotates before the threshold and retains only the configured backups", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-logs-"));
    const path = join(directory, "calsync.log");
    const logger = new RotatingFileLogger(path, { maxBytes: 1_024, backups: 2 });

    for (let index = 0; index < 6; index += 1) {
      logger.write(JSON.stringify({ event: "test", sequence: index, padding: "x".repeat(700) }));
    }

    expect(readdirSync(directory).sort()).toEqual([
      "calsync.log",
      "calsync.log.1",
      "calsync.log.2",
    ]);
    expect(statSync(path).size).toBeLessThanOrEqual(1_024);
    expect(readFileSync(path, "utf8")).toContain('"sequence":5');
    expect(readFileSync(`${path}.1`, "utf8")).toContain('"sequence":4');
    expect(readFileSync(`${path}.2`, "utf8")).toContain('"sequence":3');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(directory, { recursive: true });
  });

  it("rejects unsafe or unbounded rotation settings", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-log-config-"));
    expect(
      () => new RotatingFileLogger(join(directory, "small.log"), { maxBytes: 100, backups: 5 }),
    ).toThrow("at least 1024");
    expect(
      () => new RotatingFileLogger(join(directory, "many.log"), { maxBytes: 1_024, backups: 101 }),
    ).toThrow("1 through 100");
    rmSync(directory, { recursive: true });
  });
});
