export const WRITE_BEHIND_BYTES = 4 * 1024 * 1024;

export type StagedFile = { sha: string; saved: Promise<void> };

export class FileWriter {
  private readonly pending = new Set<Promise<void>>();
  private queued = 0;
  private failure: unknown = null;
  private failed = false;

  constructor(
    private readonly stage: (data: Uint8Array, ext: string) => StagedFile,
    private readonly budget = WRITE_BEHIND_BYTES,
  ) {}

  get inFlightBytes(): number {
    return this.queued;
  }

  async put(data: Uint8Array, ext: string): Promise<string> {
    while (this.pending.size && this.queued + data.length > this.budget) await Promise.race(this.pending);
    this.raise();
    const staged = this.stage(data, ext);
    const size = data.length;
    this.queued += size;
    const tracked: Promise<void> = staged.saved
      .catch((error: unknown) => {
        if (!this.failed) {
          this.failed = true;
          this.failure = error;
        }
      })
      .finally(() => {
        this.queued -= size;
        this.pending.delete(tracked);
      });
    this.pending.add(tracked);
    return staged.sha;
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
    this.raise();
  }

  private raise() {
    if (this.failed) throw this.failure;
  }
}
