import type { ReconcileProgress } from "@calsync/engine";

export interface ProgressOutput {
  isTTY?: boolean;
  write(value: string): unknown;
}

export class TerminalProgress {
  readonly enabled: boolean;
  private rendered = false;

  constructor(
    private readonly output: ProgressOutput = process.stderr,
    enabled = output.isTTY === true,
  ) {
    this.enabled = enabled && output.isTTY === true;
  }

  update(progress: ReconcileProgress): void {
    if (!this.enabled) {
      return;
    }
    const total = progress.total === undefined ? "?" : String(progress.total);
    this.output.write(
      `\r\u001B[2K${progress.label}: ${String(progress.completed)}/${total} | ${String(progress.succeeded)} succeeded | ${String(progress.failed)} failed`,
    );
    this.rendered = true;
  }

  finish(): void {
    if (!this.enabled || !this.rendered) {
      return;
    }
    this.output.write("\r\u001B[2K");
    this.rendered = false;
  }

  bindSignalCleanup(): () => void {
    if (!this.enabled) {
      return () => undefined;
    }
    const handlers = new Map<NodeJS.Signals, () => void>();
    const dispose = (): void => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
      handlers.clear();
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        this.finish();
        dispose();
        process.kill(process.pid, signal);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    return dispose;
  }
}
