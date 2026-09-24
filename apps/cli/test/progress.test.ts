import { describe, expect, it, vi } from "vitest";

import { TerminalProgress, type ProgressOutput } from "../src/progress.js";

function output(isTTY: boolean): ProgressOutput & { write: ReturnType<typeof vi.fn> } {
  return { isTTY, write: vi.fn(() => true) };
}

describe("TerminalProgress", () => {
  it("renders privacy-safe TTY updates and clears the line when finished", () => {
    const stream = output(true);
    const progress = new TerminalProgress(stream);

    progress.update({
      phase: "discovering",
      label: "Reading calendar events",
      completed: 25,
      succeeded: 0,
      failed: 0,
    });
    progress.update({
      phase: "applying",
      label: "Applying personal → work",
      completed: 4,
      total: 10,
      succeeded: 3,
      failed: 1,
    });
    progress.finish();

    const rendered = stream.write.mock.calls.map(([value]) => String(value)).join("");
    expect(rendered).toContain("Reading calendar events: 25/?");
    expect(rendered).toContain("Applying personal → work: 4/10 | 3 succeeded | 1 failed");
    expect(rendered.endsWith("\r\u001B[2K")).toBe(true);
    expect(rendered).not.toContain("event id");
    expect(rendered).not.toContain("title");
  });

  it("emits no ANSI or progress noise for non-TTY output", () => {
    const stream = output(false);
    const progress = new TerminalProgress(stream);

    progress.update({
      phase: "applying",
      label: "Deleting managed mirrors",
      completed: 1,
      total: 2,
      succeeded: 0,
      failed: 1,
    });
    progress.finish();

    expect(progress.enabled).toBe(false);
    expect(stream.write.mock.calls).toHaveLength(0);
  });

  it("can be explicitly disabled for a TTY", () => {
    const stream = output(true);
    const progress = new TerminalProgress(stream, false);

    progress.update({
      phase: "finalizing",
      label: "Finalizing reconciliation",
      completed: 1,
      total: 1,
      succeeded: 1,
      failed: 0,
    });

    expect(stream.write.mock.calls).toHaveLength(0);
  });
});
