import { describe, expect, it } from "vitest";

import {
  MemoryCalendar,
  MemoryExclusionSource,
  MemoryMappingStore,
  MemorySyncStateStore,
  readSyncSummary,
  SyncEngine,
  type CalendarAPI,
  type SyncConfig,
} from "../src/index.js";

const config: SyncConfig = {
  tenantId: "default",
  calendars: [
    { key: "personal", calendarId: "personal-calendar", source: true, destination: true },
    { key: "work", calendarId: "work-calendar", source: true, destination: true },
  ],
  window: { pastDays: 30, futureDays: 365 },
  timezone: "UTC",
  exclusions: { keys: {}, keywords: {} },
};

describe("pure engine ports", () => {
  it("reconciles through CalendarAPI and in-memory stores without SQLite or HTTP", async () => {
    const mappings = new MemoryMappingStore();
    const syncState = new MemorySyncStateStore();
    const exclusions = new MemoryExclusionSource();
    const personal = new MemoryCalendar([
      {
        id: "personal-source",
        etag: '"v1"',
        iCalUID: "personal-source@example.test",
        start: { dateTime: "2026-08-10T10:00:00Z" },
        end: { dateTime: "2026-08-10T11:00:00Z" },
      },
    ]);
    const work = new MemoryCalendar();
    const clients: Record<"personal" | "work", CalendarAPI> = { personal, work };
    const engine = new SyncEngine(config, mappings, syncState, exclusions, clients);

    const result = await engine.once();

    expect(result).toMatchObject({
      created: 1,
      failed: 0,
      converged: true,
      destinations: { work: { active: 1 } },
    });
    expect(work.events).toHaveLength(1);
    expect(work.events[0]).toMatchObject({ summary: "Busy", visibility: "private" });
    expect(mappings.listMappings("work")).toHaveLength(1);
    expect(syncState.getState("incremental:configuration-fingerprint")).toBeNull();
  });
});

describe("readSyncSummary", () => {
  it("reads tenant-scoped aggregates, with legacy keys for the default tenant", () => {
    const state = new MemorySyncStateStore();
    const result = JSON.stringify({
      created: 1,
      updated: 0,
      deleted: 0,
      repaired: 0,
      failed: 0,
      converged: true,
      destinations: { work: { active: 3, duplicateSuppressed: 0 } },
      sources: { personal: { excluded: 0 } },
    });
    state.setState("incremental:last-full-sync", "2026-08-28T09:00:00.000Z");
    state.setState("incremental:last-result", result);
    state.setState("tenant:acme:incremental:last-full-sync", "2026-08-28T10:00:00.000Z");

    expect(readSyncSummary(state)).toMatchObject({
      lastFullSyncAt: "2026-08-28T09:00:00.000Z",
      lastResult: { converged: true, destinations: { work: { active: 3 } } },
    });
    expect(readSyncSummary(state, "default").lastFullSyncAt).toBe("2026-08-28T09:00:00.000Z");
    expect(readSyncSummary(state, "acme")).toEqual({
      lastFullSyncAt: "2026-08-28T10:00:00.000Z",
      lastResult: null,
    });

    state.setState("incremental:last-result", "{corrupt");
    expect(readSyncSummary(state).lastResult).toBeNull();
  });

  it("converts a result saved before calendars were keyed", () => {
    const state = new MemorySyncStateStore();
    state.setState(
      "incremental:last-result",
      JSON.stringify({
        created: 0,
        updated: 0,
        deleted: 0,
        repaired: 0,
        failed: 0,
        converged: true,
        mirrors: {
          personalToWork: { active: 3, excluded: 2, duplicateSuppressed: 1 },
          workToPersonal: { active: 4, excluded: 0, duplicateSuppressed: 5 },
        },
      }),
    );

    expect(readSyncSummary(state).lastResult).toMatchObject({
      destinations: {
        work: { active: 3, duplicateSuppressed: 1 },
        personal: { active: 4, duplicateSuppressed: 5 },
      },
      sources: { personal: { excluded: 2 }, work: { excluded: 0 } },
    });
  });
});
