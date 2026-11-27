import type { LogFile, SnapshotFile, SyncFile } from "./scopeState.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isMapOf = (v: unknown, item: (x: unknown) => boolean) => isObject(v) && Object.values(v).every(item);
const isOrigin = (v: unknown) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && isCount(v[1]);
const isValue = (o: Record<string, unknown>) => Object.prototype.hasOwnProperty.call(o, "v") && o.v !== undefined;
const isOp = (v: unknown) => isObject(v) && typeof v.k === "string" && typeof v.h === "string" && isValue(v);
const isRecord = (v: unknown) => isObject(v) && typeof v.h === "string" && isOrigin(v.o) && isValue(v);

export function parseSyncFile(payload: string): SyncFile | null {
  let file: unknown;
  try {
    file = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isObject(file) || file.v !== 1 || typeof file.device !== "string" || !isTime(file.at)) return null;
  if (file.kind === "log") return isCount(file.seq) && Array.isArray(file.ops) && file.ops.every(isOp) ? (file as LogFile) : null;
  if (file.kind === "snapshot") {
    return isMapOf(file.vv, isCount) && isMapOf(file.seen, isTime) && isMapOf(file.records, isRecord) ? (file as SnapshotFile) : null;
  }
  return null;
}
