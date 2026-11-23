import { frameKey, unnamed, type FrameNames, type NativeFrame } from "../lib/native-frames";
import { count, triageDatabase, triageRows, TriageNotConfigured } from "./triage/connection";

const MAX_FRAMES = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function frameNamesSql(db: string, wanted: { uuid: string; offset: number }[]): string | null {
  if (!/^\w+$/.test(db)) return null;
  const valid = wanted.filter((w) => UUID.test(w.uuid) && Number.isSafeInteger(w.offset) && w.offset >= 0).slice(0, MAX_FRAMES);
  if (!valid.length) return null;
  const uuids = [...new Set(valid.map((w) => `'${w.uuid}'`))].join(", ");
  const offsets = [...new Set(valid.map((w) => w.offset))].join(", ");
  return `SELECT uuid, offset, symbol, symbol_offset FROM ${db}.ardia_frame_symbols FINAL WHERE symbol != '' AND uuid IN (${uuids}) AND offset IN (${offsets})`;
}

export async function frameNames(frames: NativeFrame[], signal?: AbortSignal): Promise<FrameNames> {
  const names: FrameNames = new Map();
  const wanted = unnamed(frames);
  if (!wanted.length) return names;
  try {
    const sql = frameNamesSql(triageDatabase(), wanted);
    if (!sql) return names;
    const want = new Set(wanted.map((w) => frameKey(w.uuid, w.offset)));
    for (const row of await triageRows(sql, signal)) {
      const key = frameKey(String(row.uuid), count(row.offset));
      if (want.has(key) && typeof row.symbol === "string" && row.symbol) names.set(key, { symbol: row.symbol, delta: count(row.symbol_offset) });
    }
  } catch (error) {
    if (!(error instanceof TriageNotConfigured) && !signal?.aborted) console.warn(`[frames] names unavailable, showing raw frames: ${error instanceof Error ? error.message : error}`);
  }
  return names;
}
