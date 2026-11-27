export const READ_AHEAD_BYTES = 8 * 1024 * 1024;
export const READ_AHEAD_COUNT = 4;

type Settled = { ok: true; data: Uint8Array } | { ok: false; error: unknown };

export class ReadAhead<K> {
  private readonly pending = new Map<K, { size: number; result: Promise<Settled> }>();
  private bytes = 0;

  constructor(
    private readonly read: (key: K) => Promise<Uint8Array>,
    private readonly sizeOf: (key: K) => number,
    private readonly budget = READ_AHEAD_BYTES,
    private readonly count = READ_AHEAD_COUNT,
  ) {}

  get queuedBytes(): number {
    return this.bytes;
  }

  get queued(): number {
    return this.pending.size;
  }

  want(keys: Iterable<K>): void {
    for (const key of keys) {
      if (this.pending.has(key)) continue;
      if (this.pending.size >= this.count) return;
      const size = Math.max(0, this.sizeOf(key));
      if (this.pending.size && this.bytes + size > this.budget) return;
      this.bytes += size;
      const result = this.read(key).then(
        (data): Settled => ({ ok: true, data }),
        (error: unknown): Settled => ({ ok: false, error }),
      );
      this.pending.set(key, { size, result });
    }
  }

  keep(keys: Iterable<K>): void {
    const wanted = new Set(keys);
    for (const [key, held] of this.pending)
      if (!wanted.has(key)) {
        this.pending.delete(key);
        this.bytes -= held.size;
      }
    this.want(wanted);
  }

  has(key: K): boolean {
    return this.pending.has(key);
  }

  async take(key: K): Promise<Uint8Array> {
    const held = this.pending.get(key);
    if (!held) return this.read(key);
    this.pending.delete(key);
    this.bytes -= held.size;
    const settled = await held.result;
    if (!settled.ok) throw settled.error;
    return settled.data;
  }

  drop(): void {
    this.pending.clear();
    this.bytes = 0;
  }
}
