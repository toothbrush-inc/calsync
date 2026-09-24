import { describe, expect, it, vi } from "vitest";

import type { ManagedBusyEvent, ManagedBusyEventInsert } from "@calsync/engine";

import { CalendarClient, type GoogleCalendarApi } from "../src/google/calendar.js";

const managedEvent: ManagedBusyEventInsert = {
  id: "0123456789abcdef",
  summary: "Busy",
  visibility: "private",
  transparency: "opaque",
  start: { date: "2026-08-10" },
  end: { date: "2026-08-11" },
  reminders: { useDefault: false, overrides: [] },
  extendedProperties: {
    private: {
      calsyncManaged: "true",
      calsyncMapping: "mapping",
    },
  },
};

function createApi(overrides: Partial<GoogleCalendarApi["events"]> = {}): GoogleCalendarApi {
  return {
    events: {
      list: vi.fn(() => Promise.resolve({ data: {} })),
      insert: vi.fn(() => Promise.resolve({ data: {} })),
      patch: vi.fn(() => Promise.resolve({ data: {} })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
      ...overrides,
    },
  };
}

describe("CalendarClient", () => {
  it("paginates expanded event reads with deleted instances", async () => {
    const list = vi
      .fn<GoogleCalendarApi["events"]["list"]>()
      .mockResolvedValueOnce({
        data: {
          items: [{ id: "first" }],
          nextPageToken: "next",
        },
      })
      .mockResolvedValueOnce({
        data: { items: [{ id: "second", status: "cancelled" }] },
      });
    const api = createApi({ list });
    const client = new CalendarClient(api);
    const progress: { fetched: number; complete: boolean }[] = [];

    await expect(
      client.listEvents(
        "calendar",
        {
          timeMin: "2026-01-01T00:00:00Z",
          timeMax: "2027-01-01T00:00:00Z",
          timeZone: "UTC",
        },
        (entry) => progress.push(entry),
      ),
    ).resolves.toEqual([{ id: "first" }, { id: "second", status: "cancelled" }]);
    expect(list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        calendarId: "calendar",
        singleEvents: true,
        showDeleted: true,
        orderBy: "startTime",
        timeZone: "UTC",
      }),
    );
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: "next" }));
    expect(progress).toEqual([
      { fetched: 1, complete: false },
      { fetched: 2, complete: false },
      { fetched: 2, complete: true },
    ]);
  });

  it("lists managed events across the full calendar for cleanup", async () => {
    const list = vi
      .fn<GoogleCalendarApi["events"]["list"]>()
      .mockResolvedValueOnce({
        data: { items: [{ id: "managed-first" }], nextPageToken: "managed-next" },
      })
      .mockResolvedValueOnce({
        data: { items: [{ id: "managed-second" }] },
      });
    const client = new CalendarClient(createApi({ list }));

    await expect(client.listManagedEvents("calendar")).resolves.toEqual([
      { id: "managed-first" },
      { id: "managed-second" },
    ]);
    expect(list).toHaveBeenNthCalledWith(1, {
      calendarId: "calendar",
      showDeleted: false,
      maxResults: 2_500,
      privateExtendedProperty: ["calsyncManaged=true"],
    });
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: "managed-next" }));
  });

  it("paginates incremental changes and returns only the final sync token", async () => {
    const list = vi
      .fn<GoogleCalendarApi["events"]["list"]>()
      .mockResolvedValueOnce({
        data: {
          items: [{ id: "changed" }],
          nextPageToken: "page-two",
          nextSyncToken: "premature-token",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ id: "deleted", status: "cancelled" }],
          nextSyncToken: "final-token",
        },
      });
    const client = new CalendarClient(createApi({ list }));

    await expect(client.listChanges("calendar", { syncToken: "old-token" })).resolves.toEqual({
      events: [{ id: "changed" }, { id: "deleted", status: "cancelled" }],
      nextSyncToken: "final-token",
    });
    expect(list).toHaveBeenNthCalledWith(1, {
      calendarId: "calendar",
      showDeleted: true,
      maxResults: 2_500,
      fields: "items(id,status,etag,extendedProperties/private),nextPageToken,nextSyncToken",
      syncToken: "old-token",
    });
    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ syncToken: "old-token", pageToken: "page-two" }),
    );
  });

  it("does not produce an incremental token when a later page fails", async () => {
    const list = vi
      .fn<GoogleCalendarApi["events"]["list"]>()
      .mockResolvedValueOnce({
        data: { items: [{ id: "changed" }], nextPageToken: "page-two" },
      })
      .mockRejectedValueOnce(new Error("page failed"));
    const client = new CalendarClient(createApi({ list }), { maxAttempts: 1 });

    await expect(client.listChanges("calendar", { syncToken: "old-token" })).rejects.toThrow(
      "page failed",
    );
  });

  it("suppresses updates and applies etags to mutations", async () => {
    const insert = vi.fn(() => Promise.resolve({ data: {} }));
    const patch = vi.fn(() => Promise.resolve({ data: {} }));
    const deleteEvent = vi.fn(() => Promise.resolve({ data: {} }));
    const api = createApi({ insert, patch, delete: deleteEvent });
    const client = new CalendarClient(api);
    const patchBody: ManagedBusyEvent = managedEvent;

    await client.insertEvent("calendar", managedEvent);
    await client.patchEvent("calendar", "destination", patchBody, '"etag"');
    await client.deleteEvent("calendar", "destination");

    expect(insert).toHaveBeenCalledWith({
      calendarId: "calendar",
      requestBody: managedEvent,
      sendUpdates: "none",
    });
    expect(patch).toHaveBeenCalledWith(
      {
        calendarId: "calendar",
        eventId: "destination",
        requestBody: patchBody,
        sendUpdates: "none",
      },
      { headers: { "If-Match": '"etag"' } },
    );
    expect(deleteEvent).toHaveBeenCalledWith({
      calendarId: "calendar",
      eventId: "destination",
      sendUpdates: "none",
    });
  });

  it("retries transient failures with bounded backoff", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const insert = vi
      .fn<GoogleCalendarApi["events"]["insert"]>()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce({ data: {} });
    const client = new CalendarClient(createApi({ insert }), {
      maxAttempts: 2,
      initialDelayMs: 10,
      maxDelayMs: 10,
      random: () => 0.5,
      sleep,
    });

    await client.insertEvent("calendar", managedEvent);

    expect(insert).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it("retries quota-related 403 responses and honors Retry-After", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const insert = vi
      .fn<GoogleCalendarApi["events"]["insert"]>()
      .mockRejectedValueOnce({
        response: {
          status: 403,
          headers: { "retry-after": "2" },
          data: {
            error: {
              message: "Calendar usage limits exceeded.",
              errors: [{ reason: "calendarUsageLimitsExceeded" }],
            },
          },
        },
      })
      .mockResolvedValueOnce({ data: {} });
    const client = new CalendarClient(createApi({ insert }), {
      maxAttempts: 2,
      maxDelayMs: 5_000,
      sleep,
    });

    await client.insertEvent("calendar", managedEvent);

    expect(insert).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("treats deterministic insert conflicts and missing deletes as success", async () => {
    const insert = vi
      .fn<GoogleCalendarApi["events"]["insert"]>()
      .mockRejectedValue({ response: { status: 409 } });
    const deleteEvent = vi
      .fn<GoogleCalendarApi["events"]["delete"]>()
      .mockRejectedValue({ code: 404 });
    const client = new CalendarClient(createApi({ insert, delete: deleteEvent }));

    await expect(client.insertEvent("calendar", managedEvent)).resolves.toBeUndefined();
    await expect(client.deleteEvent("calendar", "missing")).resolves.toBeUndefined();
  });

  it("does not retry an actual insufficientPermissions response", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const list = vi.fn<GoogleCalendarApi["events"]["list"]>().mockRejectedValue({
      response: {
        status: 403,
        data: {
          error: {
            message: "Request had insufficient authentication scopes.",
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
      },
    });
    const client = new CalendarClient(createApi({ list }), {
      maxAttempts: 4,
      sleep,
    });

    await expect(
      client.listEvents("calendar", {
        timeMin: "2026-01-01T00:00:00Z",
        timeMax: "2027-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
