import { CRASH_AGES, CRASH_KINDS, CRASH_REASONS, PREVIOUS_SESSIONS, type EventProps } from "./telemetrySchema.ts";

export const SESSION_KEY = "telemetry_session";
export const PENDING_CRASH_KEY = "telemetry_pending_crash";
export const MOST_CRASHES_PER_LAUNCH = 10;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type CrashKind = (typeof CRASH_KINDS)[number];
type CrashReason = (typeof CRASH_REASONS)[number];
type CrashAge = (typeof CRASH_AGES)[number];
export type PreviousSession = (typeof PREVIOUS_SESSIONS)[number];
export type SessionMark = "open" | "closed";

const ERROR_REASONS: Record<string, CrashReason> = {
  TypeError: "type_error",
  ReferenceError: "reference_error",
  RangeError: "range_error",
  SyntaxError: "syntax_error",
  Error: "error",
};

export function jsErrorReason(error: unknown): CrashReason {
  const name = error instanceof Error ? error.name : typeof error === "object" && error !== null ? (error as { name?: unknown }).name : null;
  return typeof name === "string" && Object.hasOwn(ERROR_REASONS, name) ? ERROR_REASONS[name]! : "other";
}

export const crashAge = (ms: number): CrashAge => (ms < HOUR ? "<1h" : ms < DAY ? "<1d" : ms < 7 * DAY ? "<7d" : "7d+");

export function previousSession(mark: string | null): PreviousSession {
  if (mark === null) return "none";
  if (mark === "closed") return "clean";
  if (mark === "open") return "unclean";
  return "unknown";
}

export const sessionMark = (active: boolean, sharing: boolean): SessionMark | null => (!sharing ? null : active ? "open" : "closed");

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

export function crashProps(raw: unknown, now: number): EventProps<"app_crashed"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind, reason, foreground, at } = raw as Record<string, unknown>;
  if (!isOneOf<CrashKind>(CRASH_KINDS, kind) || !isOneOf<CrashReason>(CRASH_REASONS, reason)) return null;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
  const shown = foreground === "yes" || foreground === "no" ? foreground : "unknown";
  return { kind, reason, foreground: shown, ago: crashAge(Math.max(0, now - at)) };
}

export const foregroundOf = (appState: string | null | undefined): "yes" | "no" | "unknown" => (appState === "active" ? "yes" : appState === "background" || appState === "inactive" ? "no" : "unknown");

export function pendingJsCrash(reason: CrashReason, at: number, appState: string | null | undefined): string {
  return JSON.stringify({ kind: "js", reason, foreground: foregroundOf(appState), at });
}

const SAME_EXIT_MS = 30_000;
const JS_EXIT_REASONS = new Set(["java_crash", "native_crash"]);

export function readPendingCrash(raw: string | null, now: number): { props: EventProps<"app_crashed">; at: number } | null {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as { at?: unknown };
    const props = crashProps(record, now);
    return props && typeof record.at === "number" ? { props, at: record.at } : null;
  } catch {
    return null;
  }
}

const sameExitAsJs = (record: unknown, jsAt: number | null) => {
  if (jsAt === null || typeof record !== "object" || record === null) return false;
  const { reason, at } = record as { reason?: unknown; at?: unknown };
  return typeof reason === "string" && JS_EXIT_REASONS.has(reason) && typeof at === "number" && Math.abs(at - jsAt) <= SAME_EXIT_MS;
};

export function crashesToSend(raw: unknown, now: number, jsAt: number | null = null): EventProps<"app_crashed">[] {
  if (!Array.isArray(raw)) return [];
  const out: EventProps<"app_crashed">[] = [];
  for (const record of raw) {
    if (sameExitAsJs(record, jsAt)) continue;
    const props = crashProps(record, now);
    if (props) out.push(props);
    if (out.length >= MOST_CRASHES_PER_LAUNCH) break;
  }
  return out;
}

export type CrashSources = { sharing(): boolean; readPending(): string | null; clearPending(): void; takeExits(): unknown[] };

export function collectCrashes(io: CrashSources, now: number, left: number): EventProps<"app_crashed">[] {
  if (!io.sharing() || left <= 0) return [];
  const pending = io.readPending();
  if (pending !== null) io.clearPending();
  const js = readPendingCrash(pending, now);
  return [...(js ? [js.props] : []), ...crashesToSend(io.takeExits(), now, js?.at ?? null)].slice(0, left);
}
