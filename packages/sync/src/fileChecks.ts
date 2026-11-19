import type { LogFile, Op, SnapshotFile, SyncRecord } from "./scopeState.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isMapOf = (v: unknown, item: (x: unknown) => boolean) => isObject(v) && Object.values(v).every(item);
const isOrigin = (v: unknown) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && isCount(v[1]);
const isValue = (o: Record<string, unknown>) => Object.prototype.hasOwnProperty.call(o, "v") && o.v !== undefined;
const isFileOf = (v: unknown, kind: string): v is Record<string, unknown> => isObject(v) && v.v === 1 && typeof v.device === "string" && isTime(v.at) && v.kind === kind;

export const isSyncOp = (v: unknown): v is Op => isObject(v) && typeof v.k === "string" && typeof v.h === "string" && isValue(v);
export const isSyncRecord = (v: unknown): v is SyncRecord => isObject(v) && typeof v.h === "string" && isOrigin(v.o) && isValue(v);
export const isBaseEntry = (v: unknown): v is string => typeof v === "string";
export const isSequence = isCount;
export const isLogFile = (v: unknown): v is LogFile => isFileOf(v, "log") && isCount(v.seq) && Array.isArray(v.ops) && v.ops.every(isSyncOp);
export const isSnapshotFile = (v: unknown): v is SnapshotFile =>
  isFileOf(v, "snapshot") && isMapOf(v.vv, isCount) && isMapOf(v.seen, isTime) && isMapOf(v.records, isSyncRecord);
