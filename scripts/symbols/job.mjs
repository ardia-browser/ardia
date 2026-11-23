import { frameKey, wantedFrames } from "./frames.mjs";
import { lookup } from "./symbol-map.mjs";

export const TABLE = "ardia_frame_symbols";
export const RETRY_MISSING_MS = 24 * 60 * 60_000;
export const KNOWN_CHUNK = 4500;
const RECHECKED = new Set(["none", "outside", "match"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTIFIER = /^\w+$/;

export const createTable = (db) => `CREATE TABLE IF NOT EXISTS ${db}.${TABLE}
(
    uuid String,
    offset UInt64,
    image LowCardinality(String),
    symbol String,
    symbol_offset UInt64,
    source LowCardinality(String),
    resolved_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(resolved_at)
ORDER BY (uuid, offset)`;

export const EVENTS_SQL = `SELECT DISTINCT
    if(event = 'app_freeze', 'freeze', 'crash') AS kind,
    if(event = 'app_freeze', properties['freeze_images'], properties['crash_images']) AS images,
    if(event = 'app_freeze', properties['freeze_frames'], properties['$exception_list']) AS frames
FROM telemetry.events
WHERE event IN ('app_freeze', '$exception')
  AND timestamp >= now() - INTERVAL {days:UInt32} DAY
  AND if(event = 'app_freeze', properties['freeze_images'], properties['crash_images']) NOT IN ('', '[]')
FORMAT JSONEachRow`;

export function knownSql(db, uuids, offsets = []) {
  if (!IDENTIFIER.test(db)) throw new Error("the sandbox database must be a plain identifier");
  const list = [...new Set(uuids.filter((u) => typeof u === "string" && UUID.test(u)))].map((u) => `'${u}'`).join(", ");
  const at = [...new Set(offsets.filter((o) => Number.isSafeInteger(o) && o >= 0))].join(", ");
  return `SELECT uuid, offset, source, symbol, symbol_offset, toUnixTimestamp64Milli(resolved_at) AS at FROM ${db}.${TABLE} FINAL WHERE uuid IN (${list || "''"}) AND offset IN (${at || "0"}) FORMAT JSONEachRow`;
}

export function plan(wanted, known, now) {
  const seen = new Map(known.map((k) => [frameKey(k.uuid, Number(k.offset)), k]));
  return wanted.filter((frame) => {
    const held = seen.get(frameKey(frame.uuid, frame.offset));
    if (!held) return true;
    return RECHECKED.has(held.source) && now - Number(held.at) >= RETRY_MISSING_MS;
  });
}

const stamp = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

export function resolve(todo, maps, now, known = []) {
  const kept = new Map(known.filter((k) => k.symbol).map((k) => [frameKey(k.uuid, Number(k.offset)), k]));
  return todo.map((frame) => {
    const map = maps.get(frame.uuid);
    const found = map ? lookup(map, frame.offset) : null;
    const hit = found?.name ? found : null;
    const previous = kept.get(frameKey(frame.uuid, frame.offset));
    if (!hit && previous) {
      return { uuid: frame.uuid, offset: frame.offset, image: frame.image, symbol: previous.symbol, symbol_offset: Number(previous.symbol_offset), source: previous.source, resolved_at: stamp(now) };
    }
    return {
      uuid: frame.uuid,
      offset: frame.offset,
      image: frame.image,
      symbol: hit ? hit.name : "",
      symbol_offset: hit ? hit.delta : 0,
      source: hit ? map.source : map ? "outside" : "none",
      resolved_at: stamp(now),
    };
  });
}

export function summarize(rows) {
  const by = (key) => rows.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] ?? 0) + 1), acc), {});
  const builds = new Set(rows.filter((r) => r.source === "none").map((r) => `${r.image} ${r.uuid}`));
  return { frames: rows.length, bySource: by("source"), byImage: by("image"), buildsWithoutSymbols: [...builds].sort() };
}

export function clickhouse({ url, user, password, fetch = globalThis.fetch }) {
  if (!url || !user || !password) return null;
  const endpoint = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:")) throw new Error(`ClickHouse URLs must use https (plain http only to localhost), got ${endpoint.protocol}//${endpoint.hostname}`);
  return async (sql, { params = {}, body } = {}) => {
    const target = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(`param_${key}`, String(value));
    if (body !== undefined) target.searchParams.set("query", sql);
    const res = await fetch(target, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`, "Content-Type": "text/plain" },
      body: body ?? sql,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
    return text;
  };
}

export const jsonLines = (text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line));

export async function run({ reader, sandbox, db = "sandbox", store, days = 14, dryRun = false, now = Date.now(), log = () => {} }) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--days takes a whole number from 1 to 90");
  if (!IDENTIFIER.test(db)) throw new Error("the sandbox database must be a plain identifier");
  const events = jsonLines(await reader(EVENTS_SQL, { params: { days } }));
  const wanted = wantedFrames(events);
  log(`${events.length} distinct stacks, ${wanted.length} distinct frames in the last ${days} days`);
  let known = [];
  if (sandbox) {
    if (!dryRun) await sandbox(createTable(db));
    try {
      for (let i = 0; i < wanted.length; i += KNOWN_CHUNK) {
        const chunk = wanted.slice(i, i + KNOWN_CHUNK);
        known.push(...jsonLines(await sandbox(knownSql(db, chunk.map((f) => f.uuid), chunk.map((f) => f.offset)))));
      }
    } catch (error) {
      if (!dryRun) throw error;
      log(`couldn't read ${db}.${TABLE}: ${error.message}`);
    }
  }
  const todo = plan(wanted, known, now);
  log(`${todo.length} frames to name`);
  const maps = todo.length ? await store.maps([...new Set(todo.map((f) => f.uuid))]) : new Map();
  const rows = resolve(todo, maps, now, known);
  if (rows.length && !dryRun) {
    if (!sandbox) throw new Error("writing names needs the sandbox ClickHouse user (TRIAGE_CLICKHOUSE_PASSWORD), or pass --dry-run");
    for (let i = 0; i < rows.length; i += 5000) {
      await sandbox(`INSERT INTO ${db}.${TABLE} FORMAT JSONEachRow`, { body: rows.slice(i, i + 5000).map((r) => JSON.stringify(r)).join("\n") });
    }
  }
  return { rows, summary: summarize(rows) };
}
