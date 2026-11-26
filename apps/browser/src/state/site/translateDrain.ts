export type Passage = [number, [number, string][], number?];
export type Translated = [number, string | null];
export type PageBatch = { passages: unknown[]; more: boolean; gone: boolean; done: number; total: number };

export const PACK_CHARS = 600;
export const FIRST_PACK_CHARS = 60;
export const PACK_PASSAGES = 24;
export const FAILED_PACKS_IN_A_ROW = 3;
export const LONG_PASSAGE = 200;
export const PASSAGE_RETRIES = 2;
export const PACK_SEPARATOR = " · ";

type DrainPort = {
  inFlight: number;
  holds(): boolean;
  released: Promise<void>;
  next(maxChars: number): Promise<PageBatch | null | undefined>;
  translate(pack: Passage[]): Promise<Translated[]>;
  apply(results: Translated[]): Promise<unknown>;
  onStage?(stage: "collect" | "model" | "apply"): void;
  onApplied?(passages: number, total: number): void;
  onFailed?(passages: number): void;
  onAbandoned?(passages: number): void;
  onOutage?(): void;
};

const MAX_PIECES = 40;

const cleanPassages = (passages: unknown[]): Passage[] =>
  passages
    .filter((p): p is Passage => Array.isArray(p) && typeof p[0] === "number" && Array.isArray(p[1]))
    .map(([id, pieces, attempt]): Passage => [id, pieces.filter((x) => Array.isArray(x) && typeof x[0] === "number" && typeof x[1] === "string").slice(0, MAX_PIECES), typeof attempt === "number" ? attempt : 0])
    .filter(([, pieces]) => pieces.length > 0);

const sizeOf = ([, pieces]: Passage) => pieces.reduce((n, [, text]) => n + text.length, 0);

export function packsOf(passages: Passage[]): Passage[][] {
  const packs: Passage[][] = [];
  let short: Passage[] = [];
  let shortChars = 0;
  for (const passage of passages) {
    const size = sizeOf(passage);
    if (size < LONG_PASSAGE) {
      const added = short.length ? size + PACK_SEPARATOR.length : size;
      if (short.length && shortChars + added > PACK_CHARS) {
        packs.push(short);
        short = [passage];
        shortChars = size;
        continue;
      }
      short.push(passage);
      shortChars += added;
      continue;
    }
    if (short.length) packs.push(short);
    short = [];
    shortChars = 0;
    packs.push([passage]);
  }
  if (short.length) packs.push(short);
  return packs;
}

const translatedIn = (pack: Passage[], results: Translated[]) => {
  const answered = new Set(results.filter(([, text]) => text !== null).map(([id]) => id));
  return pack.filter(([, pieces]) => pieces.some(([id]) => answered.has(id))).length;
};

const untranslated = ([, pieces]: Passage): Translated[] => pieces.map(([id]): Translated => [id, null]);

export async function drainPassages(port: DrainPort): Promise<boolean> {
  const running = new Set<Promise<void>>();
  const backlog: Passage[][] = [];
  let failure: { error: unknown } | null = null;
  let lastError: { error: unknown } | null = null;
  let failedInARow = 0;
  let pendingRetries = 0;
  let succeeded = 0;
  let total = 0;
  let exhausted = false;
  let asked = false;
  let released = false;
  void port.released.then(() => (released = true));
  const live = () => !released && port.holds();
  const stage = (name: "collect" | "model" | "apply") => {
    if (!failure) port.onStage?.(name);
  };
  const settleRetries = (pack: Passage[], answered: (passage: Passage) => boolean) => {
    for (const passage of pack) {
      const attempt = passage[2] ?? 0;
      if (attempt > 0) pendingRetries = Math.max(0, pendingRetries - 1);
      if (!answered(passage) && attempt < PASSAGE_RETRIES) pendingRetries++;
    }
  };
  const settle = async () => {
    await Promise.race([Promise.allSettled(running), port.released]);
    if (!live()) return false;
    if (failure) {
      port.onAbandoned?.(pendingRetries);
      throw failure.error;
    }
    if (!succeeded && lastError) throw lastError.error;
    return true;
  };
  const start = (pack: Passage[]) => {
    const job = port
      .translate(pack)
      .then(
        async (results) => {
          if (!live()) return;
          const translated = translatedIn(pack, results);
          const answered = new Set(results.filter(([, text]) => text !== null).map(([id]) => id));
          settleRetries(pack, ([, pieces]) => pieces.every(([id]) => answered.has(id)));
          if (translated && !failure) failedInARow = 0;
          if (translated) succeeded++;
          stage("apply");
          await port.apply(results);
          if (live()) port.onApplied?.(translated, total);
        },
        async (error: unknown) => {
          if (!live()) return;
          lastError = { error };
          port.onFailed?.(pack.length);
          settleRetries(pack, () => false);
          const fresh = pack.some(([, , attempt]) => !attempt);
          if (fresh && ++failedInARow >= FAILED_PACKS_IN_A_ROW && !failure) {
            port.onStage?.("model");
            failure = { error };
            port.onOutage?.();
          }
          await port.apply(pack.flatMap(untranslated)).catch(() => {});
        },
      )
      .catch((error: unknown) => {
        if (!live() || failure) return;
        failure = { error };
        port.onOutage?.();
      })
      .finally(() => running.delete(job));
    running.add(job);
  };
  for (;;) {
    if (!live()) return false;
    if (failure) return settle();
    while (running.size < port.inFlight && backlog.length) start(backlog.shift()!);
    if (running.size < port.inFlight && !exhausted) {
      stage("collect");
      const batch = await port.next(asked ? PACK_CHARS : FIRST_PACK_CHARS);
      asked = true;
      if (!live()) return false;
      if (!batch || batch.gone || !Array.isArray(batch.passages)) return false;
      total = batch.total;
      exhausted = !batch.more;
      backlog.push(...packsOf(cleanPassages(batch.passages)));
      if (backlog.length) {
        stage("model");
        continue;
      }
    }
    if (!running.size && !backlog.length) return settle();
    await Promise.race([...running, port.released]);
    exhausted = false;
  }
}
