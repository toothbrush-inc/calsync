import { describe, expect, it } from "vitest";

import { StateDatabase } from "../src/storage/database.js";
import {
  DEFAULT_SCAN_GATE_LIMITS,
  ScanGate,
  type ScanGateLimits,
  type ScanGateStore,
} from "../src/scanlimit.js";

/** A clock the test advances by hand. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function memoryStore(): ScanGateStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    getState: (key) => rows.get(key) ?? null,
    setState: (key, value) => {
      rows.set(key, value);
    },
  };
}

const limits: ScanGateLimits = {
  cacheMs: 30_000,
  scanIntervalMs: 60_000,
  writeIntervalMs: 300_000,
};

describe("ScanGate", () => {
  it("allows the first pass and holds the next one off for the rest of the gap", () => {
    const time = clock();
    const gate = new ScanGate(memoryStore(), limits, time.now);

    expect(gate.check("default", "scan")).toEqual({ allowed: true });
    gate.record("default", "scan");

    expect(gate.check("default", "scan")).toEqual({ allowed: false, retryAfterSeconds: 60 });
    time.advance(20_000);
    expect(gate.check("default", "scan")).toEqual({ allowed: false, retryAfterSeconds: 40 });
    time.advance(39_999);
    expect(gate.check("default", "scan")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    time.advance(1);
    expect(gate.check("default", "scan")).toEqual({ allowed: true });
  });

  it("gives writes their own, longer gap", () => {
    const time = clock();
    const gate = new ScanGate(memoryStore(), limits, time.now);

    gate.record("default", "write");
    expect(gate.check("default", "write")).toEqual({ allowed: false, retryAfterSeconds: 300 });
    // A write does not spend the read-only allowance.
    expect(gate.check("default", "scan")).toEqual({ allowed: true });

    time.advance(299_000);
    expect(gate.check("default", "write")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    time.advance(1_000);
    expect(gate.check("default", "write")).toEqual({ allowed: true });
  });

  it("keeps tenants out of each other's way", () => {
    const time = clock();
    const gate = new ScanGate(memoryStore(), limits, time.now);

    gate.record("acme", "scan");
    expect(gate.check("acme", "scan").allowed).toBe(false);
    expect(gate.check("default", "scan").allowed).toBe(true);
    expect(gate.check("other", "scan").allowed).toBe(true);
  });

  it("serves a remembered result until the cache window closes", () => {
    const time = clock();
    const gate = new ScanGate(memoryStore(), limits, time.now);

    expect(gate.cached("default", "check")).toBeUndefined();
    gate.remember("default", "check", { removals: 2 });
    expect(gate.cached("default", "check")).toEqual({ removals: 2 });

    time.advance(29_999);
    expect(gate.cached("default", "check")).toEqual({ removals: 2 });
    time.advance(1);
    expect(gate.cached("default", "check")).toBeUndefined();
  });

  it("drops a cached answer on request, and keeps caches per tenant and key", () => {
    const gate = new ScanGate(memoryStore(), limits, clock().now);

    gate.remember("acme", "check", "acme-check");
    gate.remember("acme", "preview", "acme-preview");
    gate.remember("other", "check", "other-check");

    gate.invalidate("acme", "check");
    expect(gate.cached("acme", "check")).toBeUndefined();
    expect(gate.cached("acme", "preview")).toBe("acme-preview");
    expect(gate.cached("other", "check")).toBe("other-check");
  });

  it("treats 0 as off, for each limit independently", () => {
    const time = clock();
    const gate = new ScanGate(
      memoryStore(),
      { cacheMs: 0, scanIntervalMs: 0, writeIntervalMs: 300_000 },
      time.now,
    );

    gate.record("default", "scan");
    expect(gate.check("default", "scan")).toEqual({ allowed: true });

    gate.remember("default", "check", "value");
    expect(gate.cached("default", "check")).toBeUndefined();

    gate.record("default", "write");
    expect(gate.check("default", "write").allowed).toBe(false);
  });

  it("does not lock a tenant out when the clock jumps backwards", () => {
    let current = 1_000_000;
    const gate = new ScanGate(memoryStore(), limits, () => current);

    gate.record("default", "scan");
    current -= 3_600_000;
    expect(gate.check("default", "scan")).toEqual({ allowed: true });
  });

  it("reads a corrupt row as never having run", () => {
    const store = memoryStore();
    const gate = new ScanGate(store, limits, clock().now);

    store.rows.set("scanlimit:scan", "not a timestamp");
    expect(gate.check("default", "scan")).toEqual({ allowed: true });
  });

  it("shares one gap across processes, through the state database", () => {
    // `calsync web` and `calsync mcp` are separate processes over one SQLite
    // file. Two gates on one database stand in for that: a pass in either one
    // has to be visible to the other, or each surface gets its own allowance.
    const database = new StateDatabase(":memory:");
    try {
      const time = clock();
      const web = new ScanGate(database, limits, time.now);
      const mcp = new ScanGate(database, limits, time.now);

      expect(mcp.check("acme", "scan")).toEqual({ allowed: true });
      web.record("acme", "scan");
      expect(mcp.check("acme", "scan")).toEqual({ allowed: false, retryAfterSeconds: 60 });

      time.advance(60_000);
      expect(mcp.check("acme", "scan")).toEqual({ allowed: true });
    } finally {
      database.close();
    }
  });

  it("namespaces the stored key by tenant, as sync_state requires", () => {
    const store = memoryStore();
    const gate = new ScanGate(store, limits, clock().now);

    gate.record("default", "scan");
    gate.record("acme", "scan");
    gate.record("acme", "write");

    expect([...store.rows.keys()].sort()).toEqual([
      "scanlimit:scan",
      "tenant:acme:scanlimit:scan",
      "tenant:acme:scanlimit:write",
    ]);
  });

  it("ships defaults that stay out of a single user's way", () => {
    expect(DEFAULT_SCAN_GATE_LIMITS).toEqual({
      cacheMs: 30_000,
      scanIntervalMs: 60_000,
      writeIntervalMs: 300_000,
    });
  });
});
