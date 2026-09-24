import type { ReconcileProgress } from "@calsync/engine";

export type PreviewProgressPhase = "waiting_for_lock" | "listing_calendars" | "reconciling";

export interface PreviewProgressReport {
  phase: PreviewProgressPhase;
  message: string;
}

export interface McpProgressExtra {
  signal: AbortSignal;
  _meta?:
    | {
        progressToken?: string | number | undefined;
      }
    | undefined;
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      message: string;
      progress: number;
    };
  }) => Promise<void>;
}

const MIN_NOTIFICATION_INTERVAL_MS = 500;

export function previewProgressFromReconcile(progress: ReconcileProgress): PreviewProgressReport {
  if (progress.phase === "discovering") {
    return {
      phase: "listing_calendars",
      message:
        progress.completed > 0
          ? `Listing calendars (${String(progress.completed)} events)`
          : "Listing calendars",
    };
  }
  return {
    phase: "reconciling",
    message: progress.label,
  };
}

const LOCK_WAIT_RESTART_HINT_MS = 8_000;

export function previewProgressFromLockWait(waitedMs: number): PreviewProgressReport {
  const seconds = String(Math.ceil(waitedMs / 1_000));
  if (waitedMs >= LOCK_WAIT_RESTART_HINT_MS) {
    return {
      phase: "waiting_for_lock",
      message:
        `Waiting for reconcile lock (${seconds}s). ` +
        "If this continues, run calsync service install so launchd runs apps/cli/dist/cli.js.",
    };
  }
  return {
    phase: "waiting_for_lock",
    message:
      waitedMs <= 0 ? "Waiting for reconcile lock" : `Waiting for reconcile lock (${seconds}s)`,
  };
}

export function createMcpProgressSink(
  extra: McpProgressExtra,
): (report: PreviewProgressReport) => Promise<void> {
  const token = extra._meta?.progressToken;
  if (token === undefined) {
    return () => Promise.resolve();
  }
  let sequence = 0;
  let lastPhase: PreviewProgressPhase | undefined;
  let lastMessage: string | undefined;
  let lastSentAt = 0;
  let chain = Promise.resolve();

  return (report) => {
    chain = chain
      .then(async () => {
        if (extra.signal.aborted) {
          return;
        }
        const now = Date.now();
        const phaseChanged = report.phase !== lastPhase;
        const messageChanged = report.message !== lastMessage;
        if (!phaseChanged && !messageChanged && now - lastSentAt < MIN_NOTIFICATION_INTERVAL_MS) {
          return;
        }
        lastPhase = report.phase;
        lastMessage = report.message;
        lastSentAt = now;
        sequence += 1;
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: sequence,
            message: report.message,
          },
        });
      })
      .catch(() => undefined);
    return chain;
  };
}
