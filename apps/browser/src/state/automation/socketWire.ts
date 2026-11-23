import type { SecretFree } from "@ardia/core";
import { noteSocketLineShrunk } from "../telemetry/cliCounts";
import type { ConsentToken } from "../telemetry/client";

export const LINE_BYTE_LIMIT = 1024 * 1024;
export const PAGE_BYTE_BUDGET = 512 * 1024;
export const CLIPPED_STRING_CHARS = 32 * 1024;

const utf8 = new TextEncoder();

export const DROPPED_MARKER_ROOM = 64;

export const frameBytes = (line: string) => utf8.encode(line).length + 1;

export const fitsOnLine = (line: string, room = 0) => (line.length + 1) * 3 + room <= LINE_BYTE_LIMIT || frameBytes(line) + room <= LINE_BYTE_LIMIT;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function clippedRow<T>(row: T): T {
  if (!isRecord(row)) return row;
  const clipped = Object.keys(row).filter((k) => typeof row[k] === "string" && (row[k] as string).length > CLIPPED_STRING_CHARS);
  if (!clipped.length) return row;
  const out: Record<string, unknown> = { ...row, clipped };
  for (const k of clipped) out[k] = (row[k] as string).slice(0, CLIPPED_STRING_CHARS);
  return out as T;
}

export function withinBudget<T>(rows: readonly T[]): T[] {
  const items: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const fitted = clippedRow(row);
    const size = utf8.encode(JSON.stringify(fitted)).length + 1;
    if (items.length && bytes + size > PAGE_BYTE_BUDGET) break;
    bytes += size;
    items.push(fitted);
  }
  return items;
}

function summary(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return Array.isArray(value) ? { count: value.length } : {};
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v)) kept[k] = { count: v.length };
    else if (typeof v === "string") kept[k] = v.length > 256 ? v.slice(0, 256) : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) kept[k] = v;
  }
  return kept;
}

type WireBody = { result: unknown } | { error: unknown };
type WireMethod = { mutates: boolean; narrow?: string } | undefined;

const TOO_BIG = (narrow: string) => `The reply would be over 1 MiB, the most a line can carry; ${narrow}.`;

const WROTE = "The change was made; the full result was over 1 MiB, so read it back with the matching read method.";
const WROTE_PART = "Part of the change was made (applied says how much, error what stopped it); the full result was over 1 MiB, so read it back with the matching read method.";
const FAILURE_MESSAGE_CHARS = 1024;

function failureOf(result: Record<string, unknown>, counted: boolean): Record<string, unknown> | null {
  const error = result.error;
  if (!isRecord(error)) return null;
  const kept: Record<string, unknown> = { ...summary(error), message: String(error.message ?? "").slice(0, FAILURE_MESSAGE_CHARS) };
  delete kept.changed;
  if (isRecord(error.changed)) kept.changed = counted ? summary(error.changed) : error.changed;
  return kept;
}

function compactWrite(id: unknown, result: unknown): string {
  const fields = isRecord(result) ? result : {};
  const ok = fields.ok !== false;
  const hint = ok ? WROTE : WROTE_PART;
  for (const counted of [false, true]) {
    const failure = failureOf(fields, counted);
    const line = JSON.stringify({ id, result: { ...summary(result), ok, oversized: true, ...(failure ? { error: failure } : {}), hint } });
    if (fitsOnLine(line)) return line;
  }
  const failure = failureOf(fields, true);
  const bare = failure ? { index: failure.index, code: failure.code, message: String(failure.message).slice(0, 256) } : null;
  return JSON.stringify({ id, result: { ok, oversized: true, ...(typeof fields.applied === "number" ? { applied: fields.applied } : {}), ...(bare ? { error: bare } : {}), hint } });
}

export function fittedReply<B extends WireBody>(id: unknown, body: B & SecretFree<B>, method: WireMethod, consent: ConsentToken | null): string {
  const line = JSON.stringify({ id, ...body });
  if (fitsOnLine(line)) return line;
  noteSocketLineShrunk(consent);
  if ("error" in body) {
    const error = isRecord(body.error) ? body.error : {};
    return JSON.stringify({ id, error: { code: typeof error.code === "string" ? error.code : "failed", message: String(error.message ?? "").slice(0, 4096) } });
  }
  if (method?.mutates) return compactWrite(id, body.result);
  return JSON.stringify({ id, error: { code: "failed", message: TOO_BIG(method?.narrow ?? "ask for less (a smaller limit, a later offset, a folder, a window or a lower depth)") } });
}

export function fittedEvent<D extends Record<string, unknown>>(name: string, time: number, data: D & SecretFree<D>, consent: ConsentToken | null): string {
  const line = JSON.stringify({ event: name, time, data });
  if (fitsOnLine(line, DROPPED_MARKER_ROOM)) return line;
  noteSocketLineShrunk(consent);
  const short = JSON.stringify({ event: name, time, data: { ...summary(data), truncated: true } });
  return fitsOnLine(short, DROPPED_MARKER_ROOM) ? short : JSON.stringify({ event: name, time, data: { truncated: true } });
}
