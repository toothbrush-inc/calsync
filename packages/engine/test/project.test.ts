import { describe, expect, it } from "vitest";

import {
  managedGoogleEventId,
  managedProjectionDrift,
  matchesManagedProjection,
  projectBusyEvent,
  projectBusyEventInsert,
} from "../src/project.js";
import type { GoogleCalendarEvent, NormalizedSourceEvent } from "../src/normalize.js";

const source: NormalizedSourceEvent = {
  id: "private-source-id",
  etag: "private-etag",
  iCalUID: "private-uid@example.com",
  occurrenceKey: "private-occurrence",
  seriesKey: "private-series",
  isRecurring: true,
  duplicateMatchKey: "private-duplicate",
  time: {
    kind: "timed",
    startDateTime: "2026-08-10T10:00:00-07:00",
    endDateTime: "2026-08-10T11:00:00-07:00",
    startTimeZone: "America/Los_Angeles",
    endTimeZone: "America/Los_Angeles",
  },
};

describe("privacy projection", () => {
  it("projects only busy timing and managed metadata", () => {
    const projected = projectBusyEvent(source, "safe-mapping-key");

    expect(projected).toEqual({
      summary: "Busy",
      visibility: "private",
      transparency: "opaque",
      start: {
        dateTime: "2026-08-10T10:00:00-07:00",
        timeZone: "America/Los_Angeles",
      },
      end: {
        dateTime: "2026-08-10T11:00:00-07:00",
        timeZone: "America/Los_Angeles",
      },
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: {
        private: {
          calsyncManaged: "true",
          calsyncMapping: "safe-mapping-key",
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("private-source-id");
    expect(JSON.stringify(projected)).not.toContain("private-uid");
  });

  it("uses an opaque deterministic Google-compatible ID for inserts", () => {
    const first = projectBusyEventInsert(source, "safe-mapping-key");
    const second = projectBusyEventInsert(source, "safe-mapping-key");

    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^[0-9a-f]{64}$/);
    expect(first.id).toBe(managedGoogleEventId("safe-mapping-key"));
    expect(first.id).not.toContain("safe-mapping-key");
  });

  it("retains date-only all-day boundaries", () => {
    const allDay: NormalizedSourceEvent = {
      id: "all-day",
      occurrenceKey: "all-day",
      seriesKey: "all-day",
      isRecurring: false,
      time: {
        kind: "all-day",
        startDate: "2026-08-10",
        endDate: "2026-08-12",
      },
    };

    expect(projectBusyEvent(allDay, "mapping")).toMatchObject({
      start: { date: "2026-08-10" },
      end: { date: "2026-08-12" },
    });
  });

  it("matches managed fields after realistic Google canonicalization", () => {
    const desired = projectBusyEvent(source, "safe-mapping-key");
    const listed: GoogleCalendarEvent = {
      id: "destination-id",
      etag: '"google-etag"',
      summary: "Busy",
      visibility: "private",
      // Opaque is the Calendar API default and may be omitted in responses.
      start: { dateTime: "2026-08-10T17:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-08-10T18:00:00Z" },
      reminders: { useDefault: false },
      extendedProperties: {
        private: {
          calsyncManaged: "true",
          calsyncMapping: "safe-mapping-key",
          unrelatedPrivateProperty: "preserved",
        },
      },
    };

    expect(managedProjectionDrift(listed, desired)).toEqual([]);
    expect(matchesManagedProjection(listed, desired)).toBe(true);
  });

  it("matches canonical all-day ranges and ignores unmanaged response fields", () => {
    const allDay: NormalizedSourceEvent = {
      id: "all-day",
      occurrenceKey: "all-day",
      seriesKey: "all-day",
      isRecurring: false,
      time: {
        kind: "all-day",
        startDate: "2026-08-10",
        endDate: "2026-08-12",
      },
    };
    const desired = projectBusyEvent(allDay, "all-day-mapping");
    const listed: GoogleCalendarEvent = {
      id: "destination-id",
      etag: '"google-etag"',
      status: "confirmed",
      summary: "Busy",
      visibility: "private",
      transparency: null,
      start: { date: "2026-08-10" },
      end: { date: "2026-08-12" },
      reminders: { useDefault: false, overrides: null },
      extendedProperties: {
        private: {
          calsyncManaged: "true",
          calsyncMapping: "all-day-mapping",
        },
      },
    };

    expect(matchesManagedProjection(listed, desired)).toBe(true);
  });

  it("detects genuine changes to every managed event concern", () => {
    const desired = projectBusyEvent(source, "safe-mapping-key");
    const tampered: GoogleCalendarEvent = {
      summary: "Not busy",
      visibility: "public",
      transparency: "transparent",
      start: { dateTime: "2026-08-10T17:30:00Z" },
      end: { dateTime: "2026-08-10T18:30:00Z" },
      reminders: {
        useDefault: true,
        overrides: [{ method: "popup", minutes: 10 }],
      },
      extendedProperties: {
        private: { calsyncMapping: "wrong-mapping" },
      },
    };

    expect(managedProjectionDrift(tampered, desired)).toEqual([
      "summary",
      "visibility",
      "transparency",
      "start",
      "end",
      "reminders",
      "managed-metadata",
    ]);
  });
});
