import { describe, expect, it } from "vitest";

import { MemoryCalendar, MemoryMappingStore } from "../src/memory.js";
import type { CalendarAPI, SyncConfig } from "../src/types.js";
import { sourceExclusionKeys } from "../src/exclusion.js";
import { normalizeSourceEvent, type GoogleCalendarEvent } from "../src/normalize.js";
import {
  CleanupPassError,
  DedupePassError,
  ReconcilePassError,
  Reconciler,
  type ReconcileLog,
} from "../src/reconcile.js";

const config: SyncConfig = {
  tenantId: "default",
  accounts: {
    personal: { tenantId: "default", role: "personal", calendarId: "personal-calendar" },
    work: { tenantId: "default", role: "work", calendarId: "work-calendar" },
  },
  window: { pastDays: 30, futureDays: 365 },
  timezone: "UTC",
  exclusions: {
    personalToWork: [],
    workToPersonal: [],
    personalToWorkKeywords: [],
    workToPersonalKeywords: [],
  },
};

function source(id: string, overrides: GoogleCalendarEvent = {}): GoogleCalendarEvent {
  return {
    id,
    etag: `"${id}-v1"`,
    iCalUID: `${id}@example.test`,
    start: { dateTime: "2026-08-10T10:00:00Z" },
    end: { dateTime: "2026-08-10T11:00:00Z" },
    ...overrides,
  };
}

function setup(personalEvents: GoogleCalendarEvent[], workEvents: GoogleCalendarEvent[] = []) {
  const state = new MemoryMappingStore();
  const personal = new MemoryCalendar(personalEvents);
  const work = new MemoryCalendar(workEvents);
  const runtimeConfig = structuredClone(config);
  const clients: Record<"personal" | "work", CalendarAPI> = { personal, work };
  const reconciler = new Reconciler(runtimeConfig, state, clients);
  return { state, personal, work, config: runtimeConfig, reconciler };
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) {
    throw new Error("expected an item");
  }
  return value;
}

describe("Reconciler", () => {
  it("reports zero active mirrors when both source calendars are empty", async () => {
    const runtime = setup([]);

    await expect(runtime.reconciler.reconcile()).resolves.toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      repaired: 0,
      ...syncSummary(0, 0),
    });
  });

  it("creates idempotently, repairs destination edits, follows source edits and deletes", async () => {
    const runtime = setup([source("personal-source")]);

    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({
      created: 1,
      mirrors: {
        personalToWork: { active: 1 },
        workToPersonal: { active: 0 },
      },
    });
    expect(runtime.work.events).toHaveLength(1);
    expect(first(runtime.state.listMappings()).destinationEtag).toMatch(/^"inserted-/u);
    expect(runtime.work.events[0]).toMatchObject({
      summary: "Busy",
      visibility: "private",
      transparency: "opaque",
      reminders: { useDefault: false, overrides: [] },
    });
    await expect(runtime.reconciler.reconcile()).resolves.toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      repaired: 0,
      ...syncSummary(1, 0),
    });

    first(runtime.work.events).summary = "Leaked edit";
    first(runtime.work.events).extendedProperties = null;
    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({ updated: 1 });
    expect(runtime.work.events[0]?.summary).toBe("Busy");
    expect(runtime.personal.events).toHaveLength(1);

    first(runtime.personal.events).start = { dateTime: "2026-08-10T12:00:00Z" };
    first(runtime.personal.events).end = { dateTime: "2026-08-10T13:00:00Z" };
    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({ updated: 1 });
    expect(runtime.work.events[0]?.start).toEqual({ dateTime: "2026-08-10T12:00:00Z" });

    runtime.personal.events.splice(0);
    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({
      deleted: 1,
      mirrors: { personalToWork: { active: 0 } },
    });
    expect(runtime.work.events).toHaveLength(0);
    expect(runtime.state.listMappings()).toHaveLength(0);
  });

  it("is a no-op after Google canonicalizes created events in both directions", async () => {
    const runtime = setup(
      [
        source("timed-with-zone", {
          start: {
            dateTime: "2026-08-10T10:00:00-07:00",
            timeZone: "America/Los_Angeles",
          },
          end: {
            dateTime: "2026-08-10T11:00:00-07:00",
            timeZone: "America/Los_Angeles",
          },
        }),
        source("all-day", {
          start: { date: "2026-08-12" },
          end: { date: "2026-08-14" },
        }),
        source("recurring-instance", {
          recurringEventId: "recurring-series",
          originalStartTime: {
            dateTime: "2026-08-15T09:00:00-04:00",
            timeZone: "America/New_York",
          },
          start: {
            dateTime: "2026-08-15T09:00:00-04:00",
            timeZone: "America/New_York",
          },
          end: {
            dateTime: "2026-08-15T10:00:00-04:00",
            timeZone: "America/New_York",
          },
        }),
      ],
      [
        source("reverse-direction", {
          start: { dateTime: "2026-08-20T16:00:00+02:00", timeZone: "Europe/Berlin" },
          end: { dateTime: "2026-08-20T17:00:00+02:00", timeZone: "Europe/Berlin" },
        }),
      ],
    );

    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({ created: 4 });
    expect(runtime.state.listMappings()).toHaveLength(4);
    canonicalizeManagedEvents(runtime.personal.events);
    canonicalizeManagedEvents(runtime.work.events);
    const insertedIds = [...runtime.personal.insertedIds, ...runtime.work.insertedIds];
    const operations: string[] = [];

    await expect(
      runtime.reconciler.reconcile({
        dryRun: true,
        log: (entry) => operations.push(`${entry.operation}:${entry.reason}`),
      }),
    ).resolves.toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      repaired: 0,
      ...syncSummary(3, 1),
    });
    expect(operations).toEqual([]);
    expect([...runtime.personal.insertedIds, ...runtime.work.insertedIds]).toEqual(insertedIds);
    expect(runtime.personal.patchedIds).toEqual([]);
    expect(runtime.work.patchedIds).toEqual([]);
    expect(runtime.state.listMappings()).toHaveLength(4);
  });

  it("updates the existing destination for genuine managed-field tampering", async () => {
    const runtime = setup([source("personal-source")]);
    await runtime.reconciler.reconcile();
    const destination = first(runtime.work.events);
    const destinationId = destination.id;
    if (destinationId == null) {
      throw new Error("expected destination ID");
    }

    const tamperings: ((event: GoogleCalendarEvent) => void)[] = [
      (event) => {
        event.visibility = null;
      },
      (event) => {
        event.transparency = "transparent";
      },
      (event) => {
        event.start = { dateTime: "2026-08-10T10:30:00Z" };
      },
      (event) => {
        event.reminders = { useDefault: true };
      },
      (event) => {
        event.reminders = {
          useDefault: false,
          overrides: [{ method: "popup", minutes: 10 }],
        };
      },
      (event) => {
        event.extendedProperties = {
          private: {
            calsyncManaged: "false",
            calsyncMapping:
              event.extendedProperties?.private?.["calsyncMapping"] ?? "missing-mapping",
          },
        };
      },
    ];

    for (const tamper of tamperings) {
      tamper(first(runtime.work.events));
      await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({
        created: 0,
        updated: 1,
      });
      expect(runtime.work.events).toHaveLength(1);
      expect(first(runtime.work.events).id).toBe(destinationId);
      expect(runtime.work.patchedIds.at(-1)).toBe(destinationId);
    }
    expect(runtime.work.insertedIds).toEqual([destinationId]);
  });

  it("suppresses cross-account iCalUID duplicates and keeps dry-run read-only", async () => {
    const personal = source("personal-source", { iCalUID: "shared@example.test" });
    const work = source("work-source", { iCalUID: "shared@example.test" });
    const runtime = setup([personal], [work]);

    await expect(runtime.reconciler.reconcile()).resolves.toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      repaired: 0,
      ...syncSummary(0, 0, { personalDuplicates: 1, workDuplicates: 1 }),
    });
    runtime.work.events.splice(0);
    await expect(runtime.reconciler.reconcile({ dryRun: true })).resolves.toMatchObject({
      created: 1,
      mirrors: { personalToWork: { active: 1 } },
    });
    expect(runtime.work.events).toHaveLength(0);
    expect(runtime.state.listMappings()).toHaveLength(0);
  });

  it("suppresses duplicates whose start instants use different timezone offsets", async () => {
    const personal = source("personal-source", {
      iCalUID: "shared@example.test",
      start: { dateTime: "2026-08-10T10:00:00-07:00" },
      end: { dateTime: "2026-08-10T11:00:00-07:00" },
    });
    const work = source("work-source", {
      iCalUID: "shared@example.test",
      start: { dateTime: "2026-08-10T17:00:00Z" },
      end: { dateTime: "2026-08-10T18:00:00Z" },
    });
    const runtime = setup([personal], [work]);

    await expect(runtime.reconciler.reconcile()).resolves.toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      repaired: 0,
      ...syncSummary(0, 0, { personalDuplicates: 1, workDuplicates: 1 }),
    });
    expect(runtime.state.listMappings()).toHaveLength(0);
  });

  it("restores a deleted destination with a stable replacement ID", async () => {
    const runtime = setup([source("personal-source")]);
    await runtime.reconciler.reconcile();
    const deletedId = first(runtime.work.events).id;
    first(runtime.work.events).status = "cancelled";

    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({ created: 1 });
    const active = runtime.work.events.find((event) => event.status !== "cancelled");
    expect(active?.id).toBeDefined();
    expect(active?.id).not.toBe(deletedId);
    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({ created: 0 });
  });

  it("counts a replacement for a cancelled destination only as created", async () => {
    const runtime = setup([source("personal-source")]);
    await runtime.reconciler.reconcile();
    const mapping = first(runtime.state.listMappings());
    runtime.state.deleteMapping(mapping.mappingKey);
    first(runtime.work.events).status = "cancelled";

    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({
      created: 1,
      repaired: 0,
    });
    expect(runtime.state.listMappings()).toHaveLength(1);
  });

  it("deletes an existing mirror when its opaque occurrence key is configured", async () => {
    const sourceEvent = source("private-google-event-id", {
      summary: "Private medical appointment",
    });
    const runtime = setup([sourceEvent]);
    await runtime.reconciler.reconcile();
    expect(runtime.work.events).toHaveLength(1);

    const normalized = normalizeSourceEvent(sourceEvent);
    if (!normalized.included) {
      throw new Error("expected normalized source");
    }
    runtime.config.exclusions.personalToWork = [
      sourceExclusionKeys("personal", normalized.event).occurrence,
    ];
    const sourceDetails: { exclusionReason?: string }[] = [];

    await expect(
      runtime.reconciler.reconcile({
        onSourceEvent: (entry) => sourceDetails.push(entry),
      }),
    ).resolves.toMatchObject({
      deleted: 1,
      mirrors: { personalToWork: { active: 0, excluded: 1 } },
    });
    expect(runtime.work.events).toHaveLength(0);
    expect(runtime.state.listMappings()).toHaveLength(0);
    expect(sourceDetails).toContainEqual(
      expect.objectContaining({ exclusionReason: "occurrence" }),
    );
  });

  it("uses one opaque series key to exclude every recurring occurrence", async () => {
    const firstOccurrence = source("instance-one", {
      recurringEventId: "private-series-id",
      originalStartTime: { dateTime: "2026-08-10T10:00:00Z" },
    });
    const secondOccurrence = source("instance-two", {
      recurringEventId: "private-series-id",
      originalStartTime: { dateTime: "2026-08-11T10:00:00Z" },
      start: { dateTime: "2026-08-11T10:00:00Z" },
      end: { dateTime: "2026-08-11T11:00:00Z" },
    });
    const runtime = setup([firstOccurrence, secondOccurrence]);
    const normalized = normalizeSourceEvent(firstOccurrence);
    if (!normalized.included) {
      throw new Error("expected normalized source");
    }
    runtime.config.exclusions.personalToWork = [
      sourceExclusionKeys("personal", normalized.event).series,
    ];

    await expect(runtime.reconciler.reconcile()).resolves.toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      repaired: 0,
      ...syncSummary(0, 0, { personalExcluded: 2 }),
    });
    expect(runtime.work.events).toHaveLength(0);
  });

  it("applies title keywords only in their configured direction", async () => {
    const runtime = setup(
      [source("personal-focus", { summary: "Team Focus" })],
      [source("work-focus", { summary: "Team Focus" })],
    );
    runtime.config.exclusions.personalToWorkKeywords = ["focus"];

    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({ created: 1 });
    expect(runtime.work.events).toHaveLength(1);
    expect(runtime.personal.events).toHaveLength(2);
    expect(runtime.personal.events.some((event) => event.summary === "Busy")).toBe(true);
  });

  it("deletes an existing mirror when its title newly matches a keyword", async () => {
    const runtime = setup([
      source("private-keyword-event-id", { summary: "Project FoCuS session" }),
    ]);
    await runtime.reconciler.reconcile();
    expect(runtime.work.events).toHaveLength(1);

    runtime.config.exclusions.personalToWorkKeywords = ["focus"];
    const sourceDetails: { exclusionReason?: string }[] = [];
    await expect(
      runtime.reconciler.reconcile({
        onSourceEvent: (entry) => sourceDetails.push(entry),
      }),
    ).resolves.toMatchObject({ deleted: 1 });

    expect(runtime.work.events).toHaveLength(0);
    expect(runtime.state.listMappings()).toHaveLength(0);
    expect(sourceDetails).toContainEqual(expect.objectContaining({ exclusionReason: "keyword" }));
  });

  it("does not keyword-exclude a source event whose title is missing", async () => {
    const runtime = setup([source("untitled", { summary: null })]);
    runtime.config.exclusions.personalToWorkKeywords = ["meeting"];

    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({ created: 1 });
    expect(runtime.work.events).toHaveLength(1);
  });

  it("keyword-excludes every matching recurring occurrence", async () => {
    const runtime = setup([
      source("standup-one", {
        summary: "Daily Standup",
        recurringEventId: "standup-series",
        originalStartTime: { dateTime: "2026-08-10T10:00:00Z" },
      }),
      source("standup-two", {
        summary: "Daily Standup",
        recurringEventId: "standup-series",
        originalStartTime: { dateTime: "2026-08-11T10:00:00Z" },
        start: { dateTime: "2026-08-11T10:00:00Z" },
        end: { dateTime: "2026-08-11T11:00:00Z" },
      }),
    ]);
    runtime.config.exclusions.personalToWorkKeywords = ["STAND"];

    await expect(runtime.reconciler.reconcile()).resolves.toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      repaired: 0,
      ...syncSummary(0, 0, { personalExcluded: 2 }),
    });
    expect(runtime.work.events).toHaveLength(0);
  });

  it("rebuilds mappings from opaque metadata and cleans up managed events", async () => {
    const runtime = setup([source("personal-source")]);
    await runtime.reconciler.reconcile();
    const mapping = first(runtime.state.listMappings());
    runtime.state.deleteMapping(mapping.mappingKey);

    await expect(runtime.reconciler.rebuild()).resolves.toMatchObject({ repaired: 1 });
    expect(runtime.state.getMapping(mapping.mappingKey)).not.toBeNull();
    await expect(runtime.reconciler.cleanup()).resolves.toMatchObject({ deleted: 1 });
    expect(runtime.work.events).toHaveLength(0);
    expect(runtime.state.listMappings()).toHaveLength(0);
  });

  it("treats a successful cleanup followed by sync as a clean create", async () => {
    const runtime = setup([source("personal-source")]);
    await runtime.reconciler.reconcile();
    expect(runtime.state.listMappings()).toHaveLength(1);

    await expect(runtime.reconciler.cleanup()).resolves.toMatchObject({ deleted: 1 });
    expect(runtime.state.listMappings()).toHaveLength(0);
    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({
      created: 1,
      repaired: 0,
    });
    expect(runtime.state.listMappings()).toHaveLength(1);
  });

  it("reports cleanup progress failure and preserves mappings for retry", async () => {
    const runtime = setup([source("personal-source")]);
    await runtime.reconciler.reconcile();
    runtime.work.failNextDelete = true;
    const progress: { phase: string; completed: number; succeeded: number; failed: number }[] = [];

    const error = await runtime.reconciler
      .cleanup({
        onProgress: (entry) => progress.push(entry),
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CleanupPassError);
    expect(error).toMatchObject({ failed: 1, result: { deleted: 0 } });
    expect(progress).toContainEqual(
      expect.objectContaining({
        phase: "applying",
        completed: 1,
        succeeded: 0,
        failed: 1,
      }),
    );
    expect(runtime.state.listMappings()).toHaveLength(1);
  });

  it("target-deletes mapped mirrors that aged outside the rolling list window", async () => {
    const runtime = setup([]);
    runtime.state.putMapping({
      mappingKey: "aged-mapping",
      sourceRole: "personal",
      sourceEventId: "aged-source",
      destinationEventId: "aged-destination",
      sourceEtag: null,
      destinationEtag: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({ deleted: 1 });

    expect(runtime.work.deletedIds).toEqual(["aged-destination"]);
    expect(runtime.state.listMappings()).toEqual([]);
  });

  it("retains retryable out-of-window mappings when targeted cleanup fails", async () => {
    const runtime = setup([]);
    runtime.state.putMapping({
      mappingKey: "aged-mapping",
      sourceRole: "personal",
      sourceEventId: "aged-source",
      destinationEventId: "aged-destination",
      sourceEtag: null,
      destinationEtag: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    runtime.work.failNextDelete = true;

    const error = await runtime.reconciler.reconcile().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReconcilePassError);
    expect(runtime.state.listMappings()).toHaveLength(1);
  });

  it("cleans an aged recurring instance while retaining the instance inside the new window", async () => {
    const current = source("current-instance", {
      recurringEventId: "private-series",
      originalStartTime: { dateTime: "2026-08-10T10:00:00Z" },
    });
    const runtime = setup([current]);
    runtime.state.putMapping({
      mappingKey: "aged-occurrence-mapping",
      sourceRole: "personal",
      sourceEventId: "aged-instance",
      destinationEventId: "aged-instance-destination",
      sourceEtag: null,
      destinationEtag: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({
      created: 1,
      deleted: 1,
      mirrors: { personalToWork: { active: 1 } },
    });

    expect(runtime.work.deletedIds).toContain("aged-instance-destination");
    expect(runtime.state.listMappings("personal")).toHaveLength(1);
  });

  describe("dedupe", () => {
    function strayBlock(id: string, overrides: GoogleCalendarEvent = {}): GoogleCalendarEvent {
      return {
        id,
        summary: "Busy",
        start: { dateTime: "2026-08-10T10:00:00Z" },
        end: { dateTime: "2026-08-10T11:00:00Z" },
        extendedProperties: { private: { calsyncManaged: "true", calsyncMapping: `stale-${id}` } },
        ...overrides,
      };
    }

    it("removes duplicates beside a live mirror and phantoms elsewhere, never the live mirror", async () => {
      const runtime = setup([source("personal-source")]);
      await runtime.reconciler.reconcile();
      const live = first(runtime.work.events);
      // Same slot written with another offset: still the same block to a person.
      runtime.work.events.push(
        strayBlock("stray-a", {
          start: { dateTime: "2026-08-10T12:00:00+02:00" },
          end: { dateTime: "2026-08-10T13:00:00+02:00" },
        }),
        strayBlock("stray-b"),
        // Alone in its slot with nothing behind it: a phantom.
        strayBlock("elsewhere", {
          start: { dateTime: "2026-08-11T10:00:00Z" },
          end: { dateTime: "2026-08-11T11:00:00Z" },
        }),
      );
      const operations: ReconcileLog[] = [];

      await expect(
        runtime.reconciler.dedupe({
          log: (entry) => {
            operations.push(entry);
          },
        }),
      ).resolves.toEqual({
        created: 0,
        updated: 0,
        deleted: 3,
        repaired: 0,
        failed: 0,
        inspected: { personal: 0, work: 4 },
        duplicates: { personal: 0, work: 2 },
        phantoms: { personal: 0, work: 1 },
      });
      expect(runtime.work.deletedIds.sort()).toEqual(["elsewhere", "stray-a", "stray-b"]);
      expect(runtime.work.events.map((event) => event.id)).toEqual([live.id]);
      expect(operations.map((entry) => entry.reason).sort()).toEqual([
        "duplicate-busy-block",
        "duplicate-busy-block",
        "phantom-busy-block",
      ]);
      expect(operations[0]).toMatchObject({
        operation: "delete",
        sourceRole: "personal",
        destinationRole: "work",
        dryRun: false,
      });
      expect(operations.every((entry) => entry.sourceTitle === undefined)).toBe(true);
      // The live mirror is untouched, so the next pass has nothing to do.
      await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({
        created: 0,
        deleted: 0,
      });
    });

    it("keeps two live mirrors that genuinely share a slot", async () => {
      const runtime = setup([source("meeting-a"), source("meeting-b")]);
      await runtime.reconciler.reconcile();
      expect(runtime.work.events).toHaveLength(2);

      await expect(runtime.reconciler.dedupe()).resolves.toMatchObject({
        deleted: 0,
        inspected: { work: 2 },
      });
      expect(runtime.work.deletedIds).toEqual([]);
    });

    it("clears every block in a slot with no live source, mapped or not, as phantoms", async () => {
      const runtime = setup([source("personal-source")]);
      await runtime.reconciler.reconcile();
      const mapping = first(runtime.state.listMappings());
      // The source is gone, but the daemon has not run yet: its mirror is
      // mapped though no longer desired, and a stray copy sits beside it.
      runtime.personal.events.splice(0);
      runtime.work.events.unshift(strayBlock("aaaa-sorts-first"));

      await expect(runtime.reconciler.dedupe()).resolves.toMatchObject({
        deleted: 2,
        duplicates: { work: 0 },
        phantoms: { work: 2 },
      });
      expect(runtime.work.deletedIds.sort()).toEqual(
        ["aaaa-sorts-first", mapping.destinationEventId].sort(),
      );
      expect(runtime.work.events).toEqual([]);
      expect(runtime.state.getMapping(mapping.mappingKey)).toBeNull();
      // The next pass has nothing left to reclaim.
      await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({
        created: 0,
        deleted: 0,
      });
    });

    it("keeps the mapped copy when a live key is mirrored twice", async () => {
      const runtime = setup([source("personal-source")]);
      await runtime.reconciler.reconcile();
      const mapping = first(runtime.state.listMappings());
      const live = first(runtime.work.events);
      runtime.work.events.unshift({ ...structuredClone(live), id: "aaaa-same-key-copy" });

      await expect(runtime.reconciler.dedupe()).resolves.toMatchObject({
        deleted: 1,
        duplicates: { work: 1 },
      });
      expect(runtime.work.deletedIds).toEqual(["aaaa-same-key-copy"]);
      expect(runtime.work.events.map((event) => event.id)).toEqual([mapping.destinationEventId]);
    });

    it("drops the mapping of a mapped block it removes", async () => {
      const runtime = setup([source("personal-source")]);
      await runtime.reconciler.reconcile();
      const mapping = first(runtime.state.listMappings());
      // Google re-created the source under a new identity: the old mirror is
      // still mapped, the new one is live.
      first(runtime.personal.events).id = "personal-source-reborn";
      first(runtime.personal.events).iCalUID = "reborn@example.test";
      await runtime.reconciler.reconcile();
      expect(runtime.work.events).toHaveLength(1);
      runtime.state.putMapping(mapping);
      runtime.work.events.push({
        ...strayBlock(mapping.destinationEventId),
        extendedProperties: {
          private: { calsyncManaged: "true", calsyncMapping: mapping.mappingKey },
        },
      });
      runtime.work.deletedIds.splice(0);

      await expect(runtime.reconciler.dedupe()).resolves.toMatchObject({ deleted: 1 });
      expect(runtime.work.deletedIds).toEqual([mapping.destinationEventId]);
      expect(runtime.state.getMapping(mapping.mappingKey)).toBeNull();
      expect(runtime.state.listMappings()).toHaveLength(1);
    });

    it("treats managed blocks outside the sync window as phantoms", async () => {
      const runtime = setup([source("personal-source")]);
      // The fake calendar ignores windows; make the work side honour one for
      // the two ancient blocks so only listManagedEvents ever returns them.
      const ancient = ["ancient-a", "ancient-b"].map((id) =>
        strayBlock(id, {
          start: { dateTime: "2019-01-01T10:00:00Z" },
          end: { dateTime: "2019-01-01T11:00:00Z" },
        }),
      );
      const listEvents = runtime.work.listEvents.bind(runtime.work);
      runtime.work.listEvents = async () =>
        (await listEvents()).filter((event) => !event.id?.startsWith("ancient-"));
      await runtime.reconciler.reconcile();
      runtime.work.events.push(...ancient);

      await expect(runtime.reconciler.dedupe({ dryRun: true })).resolves.toMatchObject({
        deleted: 2,
        inspected: { work: 3 },
        phantoms: { work: 2 },
        duplicates: { work: 0 },
      });
      await expect(runtime.reconciler.dedupe()).resolves.toMatchObject({ deleted: 2 });
      expect(runtime.work.deletedIds.sort()).toEqual(["ancient-a", "ancient-b"]);
      expect(runtime.work.events).toHaveLength(1);
    });

    it("runs removals a few at a time, paced so a burst stays under Google's quota", async () => {
      const runtime = setup([source("personal-source")]);
      await runtime.reconciler.reconcile();
      runtime.work.events.push(
        ...Array.from({ length: 8 }, (_, i) => strayBlock(`stray-${String(i)}`)),
      );
      let inFlight = 0;
      let peak = 0;
      const starts: number[] = [];
      const deleteEvent = runtime.work.deleteEvent.bind(runtime.work);
      runtime.work.deleteEvent = async (calendarId, eventId) => {
        starts.push(Date.now());
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 400));
        inFlight -= 1;
        return deleteEvent(calendarId, eventId);
      };

      await expect(runtime.reconciler.dedupe()).resolves.toMatchObject({ deleted: 8 });
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(3);
      const gaps = starts.slice(1).map((at, i) => at - (starts[i] ?? at));
      // Timer granularity can shave a few milliseconds off a gap.
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(140);
      expect(runtime.work.events).toHaveLength(1);
    });

    /** A clock the fake sleep advances, so pacing runs instantly and is observable. */
    function fakePacing() {
      let at = 1_000_000;
      const sleeps: number[] = [];
      return {
        sleeps,
        pacing: {
          now: () => at,
          sleep: (milliseconds: number) => {
            sleeps.push(milliseconds);
            at += milliseconds;
            return Promise.resolve();
          },
        },
      };
    }

    function rateLimited(retryAfterSeconds?: number): Error {
      return Object.assign(new Error("Rate Limit Exceeded"), {
        code: 403,
        errors: [{ reason: "rateLimitExceeded" }],
        ...(retryAfterSeconds === undefined
          ? {}
          : { response: { headers: { "retry-after": String(retryAfterSeconds) } } }),
      });
    }

    it("backs off and retries a throttled delete instead of failing it", async () => {
      const runtime = setup([source("personal-source")]);
      await runtime.reconciler.reconcile();
      runtime.work.events.push(strayBlock("stray-a"), strayBlock("stray-b"));
      const deleteEvent = runtime.work.deleteEvent.bind(runtime.work);
      let throttles = 2;
      runtime.work.deleteEvent = (calendarId, eventId) => {
        if (throttles > 0) {
          throttles -= 1;
          return Promise.reject(rateLimited());
        }
        return deleteEvent(calendarId, eventId);
      };
      const { pacing, sleeps } = fakePacing();
      const labels: string[] = [];

      await expect(
        runtime.reconciler.dedupe({
          pacing,
          onProgress: (progress) => {
            labels.push(progress.label);
          },
        }),
      ).resolves.toMatchObject({ deleted: 2, failed: 0 });
      expect(runtime.work.deletedIds.sort()).toEqual(["stray-a", "stray-b"]);
      // Both workers' requests went out before the cooldown: one episode, one
      // 5 s pause, and the spacing doubles from 150 ms to 300 ms afterwards.
      expect(labels.filter((label) => label.includes("slow down"))).toEqual([
        "Google asked us to slow down; pausing 5s",
      ]);
      expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(5_000);
      expect(sleeps.at(-1)).toBe(300);
    });

    it("escalates the pause on a second episode and honours a longer Retry-After", async () => {
      const runtime = setup([source("personal-source")]);
      await runtime.reconciler.reconcile();
      runtime.work.events.push(strayBlock("stray-a"));
      const deleteEvent = runtime.work.deleteEvent.bind(runtime.work);
      const replies = [rateLimited(), rateLimited(), rateLimited(90)];
      runtime.work.deleteEvent = (calendarId, eventId) => {
        const reply = replies.shift();
        return reply === undefined ? deleteEvent(calendarId, eventId) : Promise.reject(reply);
      };
      const { pacing } = fakePacing();
      const labels: string[] = [];

      await expect(
        runtime.reconciler.dedupe({
          pacing,
          onProgress: (progress) => {
            labels.push(progress.label);
          },
        }),
      ).resolves.toMatchObject({ deleted: 1, failed: 0 });
      expect(labels.filter((label) => label.includes("slow down"))).toEqual([
        "Google asked us to slow down; pausing 5s",
        "Google asked us to slow down; pausing 10s",
        "Google asked us to slow down; pausing 90s",
      ]);
    });

    it("gives up on a block after its tries run out and reports it", async () => {
      const runtime = setup([source("personal-source")]);
      await runtime.reconciler.reconcile();
      runtime.work.events.push(strayBlock("stray-a"));
      let calls = 0;
      runtime.work.deleteEvent = () => {
        calls += 1;
        return Promise.reject(rateLimited());
      };

      const failure = await runtime.reconciler
        .dedupe({ pacing: fakePacing().pacing })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DedupePassError);
      expect((failure as DedupePassError).result).toMatchObject({ deleted: 0, failed: 1 });
      expect(calls).toBe(6);
    });

    it("starts a long prune at half the rate and never paces a dry run", async () => {
      const runtime = setup([source("personal-source")]);
      await runtime.reconciler.reconcile();
      runtime.work.events.push(
        ...Array.from({ length: 101 }, (_, i) => strayBlock(`stray-${String(i).padStart(3, "0")}`)),
      );
      const dry = fakePacing();
      await expect(
        runtime.reconciler.dedupe({ dryRun: true, pacing: dry.pacing }),
      ).resolves.toMatchObject({ deleted: 101 });
      expect(dry.sleeps).toEqual([]);

      const real = fakePacing();
      await expect(runtime.reconciler.dedupe({ pacing: real.pacing })).resolves.toMatchObject({
        deleted: 101,
      });
      // Every wait is the long-prune spacing, twice the short-prune 150 ms.
      expect(new Set(real.sleeps)).toEqual(new Set([300]));
    });

    it("dedupes all-day blocks by date and leaves a dry run read-only", async () => {
      const allDay = { start: { date: "2026-08-12" }, end: { date: "2026-08-13" } };
      const runtime = setup([source("day-off", allDay)]);
      await runtime.reconciler.reconcile();
      runtime.work.events.push(strayBlock("stray-day", allDay));

      await expect(runtime.reconciler.dedupe({ dryRun: true })).resolves.toMatchObject({
        deleted: 1,
        duplicates: { work: 1 },
        phantoms: { work: 0 },
      });
      expect(runtime.work.deletedIds).toEqual([]);
      expect(runtime.work.events).toHaveLength(2);
      await expect(runtime.reconciler.dedupe()).resolves.toMatchObject({ deleted: 1 });
      expect(runtime.work.deletedIds).toEqual(["stray-day"]);
    });

    it("reports a failed removal with the partial result and carries on", async () => {
      const runtime = setup([source("personal-source")]);
      await runtime.reconciler.reconcile();
      runtime.work.events.push(strayBlock("stray-a"), strayBlock("stray-b"));
      runtime.work.failNextDelete = true;

      const failure = await runtime.reconciler.dedupe().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DedupePassError);
      expect((failure as DedupePassError).result).toMatchObject({ deleted: 1, failed: 1 });
      expect(runtime.work.deletedIds).toEqual(["stray-b"]);
      await expect(runtime.reconciler.dedupe()).resolves.toMatchObject({ deleted: 1, failed: 0 });
    });
  });

  it("recovers idempotently from a partial bidirectional API failure", async () => {
    const runtime = setup([source("personal-source")], [source("work-source")]);
    runtime.personal.failNextInsert = true;
    const progress: { phase: string; failed: number }[] = [];

    const failed = await runtime.reconciler
      .reconcile({ onProgress: (entry) => progress.push(entry) })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ReconcilePassError);
    expect((failed as ReconcilePassError).result).toMatchObject({
      created: 1,
      repaired: 0,
      failed: 1,
      converged: false,
      mirrors: {
        personalToWork: { active: 1 },
        workToPersonal: { active: 0 },
      },
    });
    expect(progress.at(-1)).toMatchObject({ phase: "finalizing", failed: 1 });
    expect(runtime.work.events).toHaveLength(2);
    expect(runtime.personal.events).toHaveLength(1);
    expect(runtime.state.listMappings()).toHaveLength(1);

    await expect(runtime.reconciler.reconcile()).resolves.toMatchObject({
      created: 1,
      failed: 0,
      converged: true,
      mirrors: {
        personalToWork: { active: 1 },
        workToPersonal: { active: 1 },
      },
    });
    expect(runtime.personal.events).toHaveLength(2);
    expect(runtime.work.events).toHaveLength(2);
    expect(runtime.state.listMappings()).toHaveLength(2);
    await expect(runtime.reconciler.reconcile()).resolves.toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      repaired: 0,
      ...syncSummary(1, 1),
    });
  });
});

function syncSummary(
  personalActive: number,
  workActive: number,
  options: {
    personalExcluded?: number;
    workExcluded?: number;
    personalDuplicates?: number;
    workDuplicates?: number;
  } = {},
) {
  return {
    failed: 0,
    converged: true,
    mirrors: {
      personalToWork: {
        active: personalActive,
        excluded: options.personalExcluded ?? 0,
        duplicateSuppressed: options.personalDuplicates ?? 0,
      },
      workToPersonal: {
        active: workActive,
        excluded: options.workExcluded ?? 0,
        duplicateSuppressed: options.workDuplicates ?? 0,
      },
    },
  };
}

function canonicalizeManagedEvents(events: GoogleCalendarEvent[]): void {
  for (const event of events) {
    if (event.extendedProperties?.private?.["calsyncManaged"] !== "true") {
      continue;
    }
    event.etag = `"canonical-${event.id ?? "event"}"`;
    event.status = "confirmed";
    event.transparency = null;
    event.reminders = { useDefault: false };
    event.extendedProperties.private["googleCanonicalField"] = "ignored";
    if (event.start?.dateTime != null) {
      event.start = {
        dateTime: new Date(event.start.dateTime).toISOString(),
        timeZone: "UTC",
      };
    }
    if (event.end?.dateTime != null) {
      event.end = {
        dateTime: new Date(event.end.dateTime).toISOString(),
      };
    }
  }
}
