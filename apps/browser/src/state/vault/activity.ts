import { create } from "zustand";
import { appendVaultLog, readVaultLog } from "../../platform/vault";
import { vaultPrefs } from "./prefs";
import { orWarn } from "../../lib/fallback";
import { onAppEvent } from "../../platform/app";

export type VaultEventKind = "grant" | "fill" | "refusal" | "skip" | "end";

export type VaultEvent = {
  time: number;
  kind: VaultEventKind;
  profile: string;
  site: string | null;
  account: string | null;
  program: string;
  signer: string | null;
  task: string | null;
  outcome: string;
  via: string;
  reason: string;
  ms?: number;
};

const KEPT = 500;
const FLUSH_MS = 1000;
const FLUSH_LINES = 32;
const REASON_CHARS = 280;

export const useVaultActivity = create<{ events: VaultEvent[]; loaded: boolean }>()(() => ({ events: [], loaded: false }));

let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let loading: Promise<void> | null = null;
let flushesOnQuit = false;

function flush() {
  timer = null;
  const lines = pending;
  pending = [];
  if (lines.length) void appendVaultLog(lines).catch(orWarn(false));
}

export const clippedReason = (why: unknown) => (typeof why === "string" ? why.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, REASON_CHARS) : "");

export function recordVaultEvent(event: VaultEvent) {
  if (!flushesOnQuit) {
    flushesOnQuit = true;
    onAppEvent((e) => e.type === "willQuit" && flushVaultActivity());
  }
  useVaultActivity.setState((s) => ({ events: [...s.events.slice(-(KEPT - 1)), event] }));
  pending.push(JSON.stringify(event));
  if (pending.length >= FLUSH_LINES) {
    if (timer) clearTimeout(timer);
    flush();
  } else if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

export const flushVaultActivity = () => (timer && clearTimeout(timer), flush());

const isEvent = (value: unknown): value is VaultEvent =>
  typeof value === "object" && value !== null && typeof (value as VaultEvent).time === "number" && typeof (value as VaultEvent).kind === "string" && typeof (value as VaultEvent).program === "string";

export function loadVaultActivity(): Promise<void> {
  loading ??= (async () => {
    const lines = await readVaultLog(KEPT).catch(orWarn([] as string[]));
    const read: VaultEvent[] = [];
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEvent(parsed)) read.push(parsed);
      } catch {}
    }
    useVaultActivity.setState((s) => {
      const seen = new Set<string>();
      const merged = [...read, ...s.events].filter((e) => {
        const key = JSON.stringify(e);
        return !seen.has(key) && !!seen.add(key);
      });
      return { loaded: true, events: merged.sort((a, b) => a.time - b.time).slice(-KEPT) };
    });
  })();
  return loading;
}

export async function vaultLog(limit: number, since: number | null, profile: string | null) {
  await loadVaultActivity();
  const reasons = vaultPrefs().logShowsReasons;
  return useVaultActivity
    .getState()
    .events.filter((e) => (since === null || e.time > since) && (profile === null || e.profile === profile))
    .slice(-limit)
    .map(({ reason, ...rest }) => (reasons ? { ...rest, reason } : rest));
}
