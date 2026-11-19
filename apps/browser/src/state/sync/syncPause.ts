import { recoveredStart } from "../../platform/launchConfig";
import { errorText } from "../../lib/errors";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { noteSyncPause } from "../telemetry/syncPauseCounts";
import type { ConsentToken } from "../telemetry/choice";
import type { SyncDoc, SyncUi } from "./syncDoc";
import { SyncStateDamaged } from "./savedStateChecks";

export const SYNC_PAUSED = "Sync is paused because Ardia didn’t start properly.";
export const SYNC_PAUSED_DETAIL = "Nothing was deleted. Resume loads Sync again.";
export const SYNC_LOCKED = `Enter your recovery phrase to keep syncing on this ${PLATFORM_TERMS.computer}.`;
export const SYNC_DAMAGED = `Sync’s saved data on this ${PLATFORM_TERMS.computer} is damaged, so Sync can’t load it. To rebuild it, stop syncing here, then turn Sync on again with your recovery phrase.`;
export const SYNC_PAUSED_REFUSAL = "Sync is paused. Resume it, or stop syncing, first.";
export const CHAIN_MISSING = "Ardia can’t find its sync data in the sync folder, so Sync is still paused.";
export const QUIT_DURING_RESUME = "Ardia quit before Sync finished resuming.";
const FOLDER_UNREACHABLE = "Sync couldn’t reach the sync folder, so it’s still paused.";
const CLEAR_UNSAVED = "Ardia couldn’t save that Sync has resumed, so it’s still paused. Try Resume again.";

export const UNSETTLED_STARTS_LIMIT = 2;
export const SETTLED_AFTER_MS = 120_000;

export const pausedByGuard = (doc: SyncDoc) => doc.enabled && !!doc.pausedByGuard;

export function damagedLoads() {
  let noted = false;
  return (error: unknown, consent: ConsentToken | null): string | null => {
    if (!(error instanceof SyncStateDamaged)) return null;
    if (!noted) {
      noted = true;
      noteSyncPause("sync_loads_refused_damaged", consent);
      warnFor(consent, "[sync] the saved state is damaged", error);
    }
    return SYNC_DAMAGED;
  };
}

export function pauseAfterUnsettledStarts(doc: SyncDoc, consent: ConsentToken | null) {
  if (!doc.enabled || doc.pausedByGuard || (doc.unsettledStarts ?? 0) < UNSETTLED_STARTS_LIMIT) return false;
  doc.pausedByGuard = true;
  noteSyncPause("sync_paused_after_unsettled_starts", consent);
  return true;
}

type CountSteps = { doc: () => SyncDoc; persist: () => Promise<void>; counting: () => boolean };

export function unsettledStarts({ doc, persist, counting }: CountSteps) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let consent: ConsentToken | null = null;

  async function settle() {
    clearTimeout(timer);
    const current = doc();
    if (!counting() || pausedByGuard(current) || !current.unsettledStarts) return;
    current.unsettledStarts = 0;
    await persist().catch((error: unknown) => warnFor(consent, "[sync] couldn't save that this start settled", error));
  }

  async function countLoad(taken: ConsentToken | null) {
    if (!counting()) return;
    consent = taken;
    const current = doc();
    current.unsettledStarts = (current.unsettledStarts ?? 0) + 1;
    await persist().catch((error: unknown) => warnFor(consent, "[sync] couldn't count this start", error));
  }

  function arm() {
    if (!counting() || stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void settle(), SETTLED_AFTER_MS);
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
  }

  return { countLoad, arm, settle, stop };
}

export function pauseAfterRecoveredStart(doc: SyncDoc, consent: ConsentToken | null, recovered = recoveredStart()) {
  if (!doc.enabled || !recovered) return false;
  doc.pausedByGuard = true;
  noteSyncPause("sync_paused_by_launch_guard", consent);
  return true;
}

export type ResumeSteps = {
  doc: () => SyncDoc;
  unlock: (deviceId: string) => Promise<boolean>;
  load: () => Promise<void>;
  countLoad: (consent: ConsentToken | null) => Promise<void>;
  arm: () => void;
  cycle: () => Promise<Partial<SyncUi> | null>;
  persist: (patch?: Partial<SyncDoc>) => Promise<void>;
  publish: (patch?: Partial<SyncUi>) => void;
  quitting: () => boolean;
  settlePaused: (error: string | null) => void;
  carryOn: () => void;
  damaged: (error: unknown, consent: ConsentToken | null) => string | null;
};

export function guardResume(steps: ResumeSteps) {
  let running: Promise<void> | null = null;
  let waitingForPhrase: { consent: ConsentToken | null } | null = null;

  async function resume(consent: ConsentToken | null, pressed: boolean) {
    const deviceId = steps.doc().deviceId;
    if (!pausedByGuard(steps.doc()) || !deviceId) return;
    if (pressed) noteSyncPause("sync_resumes", consent);
    steps.publish({ status: "resuming", error: null });
    try {
      if (!(await steps.unlock(deviceId))) {
        waitingForPhrase = { consent };
        return steps.publish({ status: "locked", error: SYNC_LOCKED });
      }
      waitingForPhrase = null;
      if (steps.quitting()) return steps.settlePaused(QUIT_DURING_RESUME);
      await steps.countLoad(consent);
      steps.arm();
      await steps.load();
      const outcome = await steps.cycle();
      if (steps.quitting()) return steps.settlePaused(QUIT_DURING_RESUME);
      if (outcome?.status !== "updated") return steps.settlePaused(outcome?.error ?? FOLDER_UNREACHABLE);
      try {
        await steps.persist({ pausedByGuard: undefined });
      } catch (error) {
        warnFor(consent, "[sync] couldn't save the resumed state", error);
        void steps.persist().catch(() => {});
        return steps.settlePaused(CLEAR_UNSAVED);
      }
      delete steps.doc().pausedByGuard;
      steps.publish(outcome);
      noteSyncPause("sync_resumes_completed", consent);
      steps.carryOn();
      steps.arm();
    } catch (error) {
      const words = steps.damaged(error, consent);
      if (!words) warnFor(consent, "[sync] resuming failed", error);
      steps.settlePaused(words ?? errorText(error));
    }
  }

  function start(consent: ConsentToken | null, pressed: boolean) {
    running ??= resume(consent, pressed).finally(() => (running = null));
    return running;
  }

  return {
    resumeSync: () => start(consentToken(), true),
    continueAfterPhrase: () => start(waitingForPhrase?.consent ?? null, false),
    running: () => running,
  };
}
