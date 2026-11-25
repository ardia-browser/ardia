export const STATE_EVENT_BUDGET_BYTES = 256 * 1024;
export const DROP_MARKER_ROOM = 64;
export const STATE_ROUND_BYTES = 1024 * 1024;

export type Event = Record<string, unknown>;
export type Item = { key: string | null; field: string; value: unknown; tag?: unknown };
export type Frame = { topic: string; data: Event; bytes: number; completes: string[]; tags: unknown[] };

const encoder = new TextEncoder();
export const byteLength = (text: string) => encoder.encode(text).length;

const LONGEST_TIME = 9_999_999_999_999;
const PAGE_ROOM = 64;
const MORE_BYTES = byteLength(',"more":true');

export const wireLine = (topic: string, time: number, data: Event) => JSON.stringify({ event: `state.${topic}`, time, data });

export const wireBytes = (line: string) => byteLength(line) + 1;

const frameBytes = (topic: string, data: Event) => wireBytes(wireLine(topic, LONGEST_TIME, data)) + MORE_BYTES + DROP_MARKER_ROOM;

function pagedGroup(value: Record<string, unknown>, room: number): Record<string, unknown>[] | null {
  const ids = value.tabIds;
  if (!Array.isArray(ids)) return null;
  const base = byteLength(JSON.stringify({ ...value, tabIds: [], tabIdsPage: { index: ids.length, count: ids.length } })) + PAGE_ROOM;
  if (base >= room) return null;
  const pages: unknown[][] = [];
  let page: unknown[] = [];
  let size = base;
  for (const id of ids) {
    const bytes = byteLength(JSON.stringify(id)) + 1;
    if (page.length && size + bytes > room) {
      pages.push(page);
      page = [];
      size = base;
    }
    page.push(id);
    size += bytes;
  }
  pages.push(page);
  return pages.map((tabIds, index) => ({ ...value, tabIds, tabIdsPage: { index, count: pages.length } }));
}

function fitted(items: Item[], room: number): Item[] {
  return items.flatMap((item) => {
    if (byteLength(JSON.stringify(item.value)) + 1 <= room) return [item];
    const pages = typeof item.value === "object" && item.value !== null ? pagedGroup(item.value as Record<string, unknown>, room) : null;
    if (!pages) throw new Error(`A ${item.field} entry is larger than one state event.`);
    return pages.map((value) => ({ ...item, value }));
  });
}

export function packFrames(topic: string, fields: readonly string[], given: Item[], options: { initial: boolean; budget?: number }): Frame[] {
  const budget = options.budget ?? STATE_EVENT_BUDGET_BYTES;
  const empty = (first: boolean): Event => ({ ...(first && options.initial ? { initial: true } : {}), ...Object.fromEntries(fields.map((f) => [f, [] as unknown[]])) });
  const envelope = frameBytes(topic, empty(true));
  const items = fitted(given, budget - envelope);
  if (!items.length && !options.initial) return [];
  const frames: Frame[] = [];
  let current: Frame = { topic, data: empty(true), bytes: envelope, completes: [], tags: [] };
  items.forEach((item, i) => {
    const bytes = byteLength(JSON.stringify(item.value)) + 1;
    if (current.bytes + bytes > budget && current.bytes > envelope) {
      frames.push(current);
      current = { topic, data: empty(false), bytes: frameBytes(topic, empty(false)), completes: [], tags: [] };
    }
    (current.data[item.field] as unknown[]).push(item.value);
    current.bytes += bytes;
    if (item.tag !== undefined) current.tags.push(item.tag);
    if (item.key !== null && items[i + 1]?.key !== item.key) current.completes.push(item.key);
  });
  frames.push(current);
  for (const frame of frames) frame.bytes = frameBytes(topic, frame.data);
  if (frames.some((f) => f.bytes > budget)) throw new Error("A state event came out larger than its budget.");
  return frames;
}

export function takeRound<F extends Pick<Frame, "topic" | "bytes">>(outbox: F[], roundBytes = STATE_ROUND_BYTES): { frame: F; more: boolean }[] {
  const round: { frame: F; more: boolean }[] = [];
  let spent = 0;
  while (outbox.length) {
    const frame = outbox[0]!;
    if (spent > 0 && spent + frame.bytes > roundBytes) break;
    outbox.shift();
    spent += frame.bytes;
    const next = outbox[0];
    round.push({ frame, more: !!next && next.topic === frame.topic && spent + next.bytes > roundBytes });
  }
  return round;
}
