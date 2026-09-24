import { describe, expect, it } from "vitest";

import {
  normalizeSourceEvent,
  normalizeSourceEvents,
  type GoogleCalendarEvent,
} from "../src/normalize.js";

describe("normalizeSourceEvent", () => {
  it("filters cancelled, transparent, declined, and managed events", () => {
    const base: GoogleCalendarEvent = {
      id: "source",
      start: { dateTime: "2026-08-10T10:00:00-07:00" },
      end: { dateTime: "2026-08-10T11:00:00-07:00" },
    };

    expect(
      normalizeSourceEvents([
        { ...base, status: "cancelled" },
        { ...base, transparency: "transparent" },
        {
          ...base,
          attendees: [{ self: true, responseStatus: "declined" }],
        },
        {
          ...base,
          extendedProperties: {
            private: { calsyncManaged: "true" },
          },
        },
      ]),
    ).toEqual([]);
  });

  it("treats missing transparency as opaque and preserves timed zones", () => {
    const result = normalizeSourceEvent({
      id: "timed",
      etag: "etag",
      iCalUID: "shared@example.com",
      start: {
        dateTime: "2026-08-10T10:00:00-07:00",
        timeZone: "America/Los_Angeles",
      },
      end: {
        dateTime: "2026-08-10T11:00:00-07:00",
        timeZone: "America/Los_Angeles",
      },
    });

    expect(result).toEqual({
      included: true,
      event: {
        id: "timed",
        etag: "etag",
        iCalUID: "shared@example.com",
        occurrenceKey: "timed",
        seriesKey: "timed",
        isRecurring: false,
        duplicateMatchKey: "shared@example.com/dateTime:2026-08-10T17:00:00.000Z",
        time: {
          kind: "timed",
          startDateTime: "2026-08-10T10:00:00-07:00",
          endDateTime: "2026-08-10T11:00:00-07:00",
          startTimeZone: "America/Los_Angeles",
          endTimeZone: "America/Los_Angeles",
        },
      },
    });
  });

  it("gives timezone-equivalent instances the same duplicate identity", () => {
    const losAngeles = normalizeSourceEvent({
      id: "la",
      iCalUID: "shared@example.com",
      start: { dateTime: "2026-08-10T10:00:00-07:00" },
      end: { dateTime: "2026-08-10T11:00:00-07:00" },
    });
    const utc = normalizeSourceEvent({
      id: "utc",
      iCalUID: "shared@example.com",
      start: { dateTime: "2026-08-10T17:00:00Z" },
      end: { dateTime: "2026-08-10T18:00:00Z" },
    });

    expect(losAngeles.included && losAngeles.event.duplicateMatchKey).toBe(
      "shared@example.com/dateTime:2026-08-10T17:00:00.000Z",
    );
    expect(utc.included && utc.event.duplicateMatchKey).toBe(
      "shared@example.com/dateTime:2026-08-10T17:00:00.000Z",
    );
  });

  it("preserves all-day semantics and recurring occurrence identity", () => {
    const result = normalizeSourceEvent({
      id: "instance-id",
      recurringEventId: "series-id",
      iCalUID: "series@example.com",
      originalStartTime: { date: "2026-08-10" },
      start: { date: "2026-08-10" },
      end: { date: "2026-08-12" },
    });

    expect(result).toEqual({
      included: true,
      event: {
        id: "instance-id",
        iCalUID: "series@example.com",
        occurrenceKey: "series-id/date:2026-08-10",
        seriesKey: "series-id",
        isRecurring: true,
        duplicateMatchKey: "series@example.com/date:2026-08-10",
        time: {
          kind: "all-day",
          startDate: "2026-08-10",
          endDate: "2026-08-12",
        },
      },
    });
  });

  it("rejects incomplete or mixed time ranges", () => {
    expect(
      normalizeSourceEvent({
        id: "broken",
        start: { date: "2026-08-10" },
        end: { dateTime: "2026-08-11T00:00:00Z" },
      }),
    ).toEqual({ included: false, reason: "invalid" });
  });
});
