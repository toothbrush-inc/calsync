import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { SyncConfig } from "../src/types.js";

import { MemoryExclusionSource } from "../src/memory.js";
import {
  applyStoredExclusions,
  isTitleExcludedByKeyword,
  matchingSourceExclusion,
  normalizeExclusionKeyword,
  parseExclusionKeywords,
  parseOpaqueExclusionKey,
  sourceExclusionKeys,
} from "../src/exclusion.js";
import type { NormalizedSourceEvent } from "../src/normalize.js";

function recurringSource(occurrence: string): NormalizedSourceEvent {
  return {
    id: `google-instance-${occurrence}`,
    iCalUID: "private-account@example.test",
    sourceTitle: "Private medical appointment",
    occurrenceKey: `google-series-id/dateTime:${occurrence}`,
    seriesKey: "google-series-id",
    isRecurring: true,
    time: {
      kind: "timed",
      startDateTime: occurrence,
      endDateTime: "2026-08-10T11:00:00Z",
    },
  };
}

describe("opaque source exclusion keys", () => {
  it("is stable, versioned, scoped, and separated by source direction", () => {
    const source = recurringSource("2026-08-10T10:00:00Z");
    const first = sourceExclusionKeys("personal", source);
    const second = sourceExclusionKeys("personal", structuredClone(source));
    const reverseDirection = sourceExclusionKeys("work", source);

    expect(first).toEqual(second);
    expect(first.occurrence).toMatch(/^calsync-exclude:v1:p2w:occ:[A-Za-z0-9_-]{43}$/);
    expect(first.series).toMatch(/^calsync-exclude:v1:p2w:series:[A-Za-z0-9_-]{43}$/);
    expect(first.occurrence).not.toBe(first.series);
    expect(reverseDirection.occurrence).not.toBe(first.occurrence);
    expect(reverseDirection.series).not.toBe(first.series);
  });

  it("conceals identifiers, titles, account data, and occurrence metadata", () => {
    const source = recurringSource("2026-08-10T10:00:00Z");
    const serialized = JSON.stringify(sourceExclusionKeys("personal", source));

    for (const sensitive of [
      source.id,
      source.seriesKey,
      source.occurrenceKey,
      source.sourceTitle,
      source.iCalUID,
      "2026-08-10T10:00:00Z",
      "personal-calendar@example.test",
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it("matches occurrence and whole-series keys while retaining legacy raw keys", () => {
    const first = recurringSource("2026-08-10T10:00:00Z");
    const second = recurringSource("2026-08-11T10:00:00Z");
    const firstKeys = sourceExclusionKeys("personal", first);
    const secondKeys = sourceExclusionKeys("personal", second);

    expect(firstKeys.series).toBe(secondKeys.series);
    expect(firstKeys.occurrence).not.toBe(secondKeys.occurrence);
    expect(matchingSourceExclusion([firstKeys.occurrence], "personal", first)).toBe("occurrence");
    expect(matchingSourceExclusion([firstKeys.occurrence], "personal", second)).toBeUndefined();
    expect(matchingSourceExclusion([firstKeys.series], "personal", second)).toBe("series");
    expect(matchingSourceExclusion([first.id], "personal", first)).toBe("legacy");
    expect(matchingSourceExclusion([first.occurrenceKey], "personal", first)).toBe("legacy");
  });
});

describe("title keyword exclusions", () => {
  it("matches trimmed case-insensitive literal substrings without word boundaries", () => {
    expect(isTitleExcludedByKeyword("Quarterly TEAM Planning", [" team "])).toBe(true);
    expect(isTitleExcludedByKeyword("Quarterly planning", ["PLAN"])).toBe(true);
    expect(isTitleExcludedByKeyword("Discuss [VIP] + C++", ["[vip]", "c++"])).toBe(true);
  });

  it("does not interpret regex syntax and ignores blanks or missing titles", () => {
    expect(isTitleExcludedByKeyword("Ordinary meeting", [".*", "^ordinary"])).toBe(false);
    expect(isTitleExcludedByKeyword("Ordinary meeting", ["", "   "])).toBe(false);
    expect(isTitleExcludedByKeyword(undefined, ["meeting"])).toBe(false);
  });
});

describe("exclusion keys per source calendar", () => {
  const event = {
    id: "event",
    occurrenceKey: "event",
    seriesKey: "event",
    isRecurring: false,
    time: {
      kind: "timed" as const,
      startDateTime: "2026-08-10T10:00:00Z",
      endDateTime: "2026-08-10T11:00:00Z",
    },
  };

  it("keeps v1 keys byte-for-byte for the two original calendars", () => {
    const digest = createHash("sha256")
      .update("calsync-exclude\0v1\0p2w\0occ\0event")
      .digest("base64url");
    expect(sourceExclusionKeys("personal", event).occurrence).toBe(
      `calsync-exclude:v1:p2w:occ:${digest}`,
    );
  });

  it("names any other calendar with a v2 tag and resolves it back", () => {
    const keys = sourceExclusionKeys("calendar-family", event);
    expect(keys.occurrence).toMatch(/^calsync-exclude:v2:[A-Za-z0-9_-]{11}:occ:[A-Za-z0-9_-]{43}$/);
    expect(keys.occurrence).not.toBe(sourceExclusionKeys("calendar-other", event).occurrence);
    expect(parseOpaqueExclusionKey(keys.series, ["personal", "work", "calendar-family"])).toBe(
      "calendar-family",
    );
    expect(() => parseOpaqueExclusionKey(keys.series, ["personal", "work"])).toThrow(
      /not connected/,
    );
  });
});

describe("CLI-managed exclusion storage", () => {
  it("parses opaque keys and rejects raw Google identifiers", () => {
    const occurrence = `calsync-exclude:v1:p2w:occ:${"a".repeat(43)}`;
    const series = `calsync-exclude:v1:w2p:series:${"b".repeat(43)}`;

    const connected = ["personal", "work"];
    expect(parseOpaqueExclusionKey(occurrence, connected)).toBe("personal");
    expect(parseOpaqueExclusionKey(` ${series} `, connected)).toBe("work");
    expect(() => parseOpaqueExclusionKey("google-event-id", connected)).toThrow(
      /opaque occurrence or series key/,
    );
    expect(() => parseOpaqueExclusionKey(occurrence, ["work"])).toThrow(/not connected/);
    expect(normalizeExclusionKeyword(" Dentist ")).toBe("dentist");
    expect(() => normalizeExclusionKeyword("   ")).toThrow(/blank/);
    expect(parseExclusionKeywords(["Dentist, therapy,,school pickup", "internal"])).toEqual([
      "dentist",
      "therapy",
      "school pickup",
      "internal",
    ]);
    expect(parseExclusionKeywords(["  ,  ", ""])).toEqual([]);
  });

  it("merges stored exclusions with environment configuration", () => {
    const source = new MemoryExclusionSource(
      [
        {
          sourceKey: "work",
          value: `calsync-exclude:v1:w2p:occ:${"d".repeat(43)}`,
          createdAt: "2026-08-10T20:00:00.000Z",
        },
      ],
      [
        {
          sourceKey: "personal",
          keyword: "dentist",
          createdAt: "2026-08-10T20:00:00.000Z",
        },
      ],
    );
    const merged: SyncConfig = applyStoredExclusions<SyncConfig>(
      {
        tenantId: "default",
        calendars: [
          { key: "personal", calendarId: "personal", source: true, destination: true },
          { key: "work", calendarId: "work", source: true, destination: true },
        ],
        window: { pastDays: 30, futureDays: 365 },
        timezone: "UTC",
        exclusions: { keys: {}, keywords: { personal: ["focus time"] } },
      },
      source,
    );

    expect(merged.exclusions.keywords["personal"]).toEqual(["focus time", "dentist"]);
    expect(merged.exclusions.keys["work"]).toEqual([
      `calsync-exclude:v1:w2p:occ:${"d".repeat(43)}`,
    ]);
  });
});
