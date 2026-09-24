import { describe, expect, it } from "vitest";

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

describe("CLI-managed exclusion storage", () => {
  it("parses opaque keys and rejects raw Google identifiers", () => {
    const occurrence = `calsync-exclude:v1:p2w:occ:${"a".repeat(43)}`;
    const series = `calsync-exclude:v1:w2p:series:${"b".repeat(43)}`;

    expect(parseOpaqueExclusionKey(occurrence)).toBe("personalToWork");
    expect(parseOpaqueExclusionKey(` ${series} `)).toBe("workToPersonal");
    expect(() => parseOpaqueExclusionKey("google-event-id")).toThrow(
      /opaque occurrence or series key/,
    );
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
          direction: "workToPersonal",
          value: `calsync-exclude:v1:w2p:occ:${"d".repeat(43)}`,
          createdAt: "2026-08-10T20:00:00.000Z",
        },
      ],
      [
        {
          direction: "personalToWork",
          keyword: "dentist",
          createdAt: "2026-08-10T20:00:00.000Z",
        },
      ],
    );
    const merged = applyStoredExclusions(
      {
        tenantId: "default",
        accounts: {
          personal: { tenantId: "default", role: "personal", calendarId: "personal" },
          work: { tenantId: "default", role: "work", calendarId: "work" },
        },
        window: { pastDays: 30, futureDays: 365 },
        timezone: "UTC",
        exclusions: {
          personalToWork: [],
          workToPersonal: [],
          personalToWorkKeywords: ["focus time"],
          workToPersonalKeywords: [],
        },
      },
      source,
    );

    expect(merged.exclusions.personalToWorkKeywords).toEqual(["focus time", "dentist"]);
    expect(merged.exclusions.workToPersonal).toEqual([
      `calsync-exclude:v1:w2p:occ:${"d".repeat(43)}`,
    ]);
  });
});
