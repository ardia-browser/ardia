import type { WindowProfileSwapped } from "../../platform/profiles";
import { useBrowser } from "../browser/store";
import { engineProfile } from "../browser/model";
import { capture, consentNow } from "./client";

export const SWAP_WAIT_MS = 12_000;

export type ProfileSwapProperties = { swap_ms?: number; swap_active_ms?: number; profile_loaded?: boolean; held_timed_out?: boolean };

type Waiter = { switchId: number; settle: (swap: ProfileSwapProperties) => void };

const waiting = new Map<string, Waiter[]>();
const latestSwitch = new Map<string, number>();
let switches = 0;

export const switchIdOf = (windowId: string) => latestSwitch.get(windowId) ?? 0;

const milliseconds = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

export function profileSwapProperties(report: WindowProfileSwapped | null | undefined): ProfileSwapProperties {
  if (!report) return {};
  const out: ProfileSwapProperties = {};
  const swap = milliseconds(report.swapMs);
  const active = milliseconds(report.activeMs);
  if (swap !== undefined) out.swap_ms = swap;
  if (active !== undefined) out.swap_active_ms = active;
  if (typeof report.profileLoaded === "boolean") out.profile_loaded = report.profileLoaded;
  if (typeof report.heldTimedOut === "boolean") out.held_timed_out = report.heldTimedOut;
  return out;
}

function awaitSwap(windowId: string): Promise<ProfileSwapProperties> {
  const switchId = ++switches;
  latestSwitch.set(windowId, switchId);
  return new Promise((resolve) => {
    const waiter: Waiter = {
      switchId,
      settle: (swap) => {
        clearTimeout(timer);
        const rest = (waiting.get(windowId) ?? []).filter((w) => w !== waiter);
        if (rest.length) waiting.set(windowId, rest);
        else waiting.delete(windowId);
        resolve(swap);
      },
    };
    const timer = setTimeout(() => waiter.settle({}), SWAP_WAIT_MS);
    waiting.set(windowId, [...(waiting.get(windowId) ?? []), waiter]);
  });
}

export function noteProfileSwapped(windowId: string, report: WindowProfileSwapped | null | undefined) {
  const switchId = report?.switchId;
  if (typeof switchId !== "number" || switchId <= 0) return;
  waiting.get(windowId)?.find((waiter) => waiter.switchId === switchId)?.settle(profileSwapProperties(report));
}

export function profileSwitched(windowId: string, from: string, to: string, profiles: number, via: Record<string, unknown>) {
  const start = Date.now();
  const consent = consentNow();
  const s = useBrowser.getState();
  const swapped = engineProfile(s, from) === engineProfile(s, to) ? Promise.resolve({}) : awaitSwap(windowId);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const switchMs = Date.now() - start;
      void swapped.then((swap) => capture("profile_switched", { switch_ms: switchMs, profiles, ...via, ...swap }, consent));
    }),
  );
}
