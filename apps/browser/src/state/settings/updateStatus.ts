import type { UpdateChannel, UpdaterState } from "../../platform/app";
import { t } from "../../lib/uiLanguage";


type SwitchCheck = NonNullable<Extract<UpdaterState, { available: true }>["switchCheck"]>;

const CHANNEL_NAMES: Record<UpdateChannel, string> = { stable: t(`Stable`), nightly: t(`Nightly`) };

export const FOLLOW_EVERY_MS = 400;
export const FOLLOW_FOR_MS = 120_000;
export const FOLLOW_UPDATE_EVERY_MS = 2_000;
export const FOLLOW_UPDATE_FOR_MS = 75 * 60 * 1000;

export type SwitchOutcome = "offered" | "upToDate" | "failed";

export function switchOutcome(check: SwitchCheck | null | undefined): SwitchOutcome | null {
  switch (check?.phase) {
    case "found":
    case "downloading":
    case "installing":
    case "ready":
      return "offered";
    case "upToDate":
    case "newerThanLatest":
      return "upToDate";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

export function updaterBusy(state: UpdaterState | undefined): boolean {
  if (!state?.available) return false;
  const phase = state.switchCheck?.phase;
  return state.sessionInProgress || phase === "waiting" || phase === "checking" || phase === "downloading" || phase === "installing";
}

export function updateUnderWay(state: UpdaterState | undefined): boolean {
  const phase = state?.available ? state.switchCheck?.phase : undefined;
  return phase === "downloading" || phase === "installing";
}

export type CheckNowControl = { title: string; checking: boolean; disabled: boolean; pressable: boolean };

export function checkNowControl(state: UpdaterState | undefined): CheckNowControl {
  const idle = { title: t(`Check Now`), checking: false, disabled: false, pressable: true };
  if (!state?.available || !state.configured) return idle;
  const phase = state.switchCheck?.phase;
  if (phase === "ready") return { title: t(`Restart to Update`), checking: false, disabled: false, pressable: true };
  if (phase === "downloading" || phase === "installing") return { title: t(`Updating…`), checking: true, disabled: false, pressable: false };
  if (phase === "waiting" || phase === "checking") return { title: t(`Checking…`), checking: true, disabled: false, pressable: true };
  if (!state.canCheck && state.sessionInProgress) return { title: t(`Checking…`), checking: true, disabled: false, pressable: false };
  return state.canCheck ? idle : { ...idle, disabled: true, pressable: false };
}

export function switchCheckLine(state: UpdaterState | undefined, app: string): string | null {
  if (!state?.available || !state.switchCheck) return null;
  const { phase, channel, version } = state.switchCheck;
  const name = CHANNEL_NAMES[channel] ?? channel;
  const current = state.displayVersion ?? state.version;
  switch (phase) {
    case "waiting":
      return `Checking ${name} once the current update finishes…`;
    case "checking":
      return `Checking ${name}…`;
    case "found":
      return version ? `${app} ${version} is available on ${name}.` : `An update is available on ${name}.`;
    case "upToDate":
      return `You're up to date on ${name}.`;
    case "newerThanLatest":
      return channel === "stable"
        ? `${current} is newer than the latest Stable, so ${app} stays on it until a newer Stable ships.`
        : `You're up to date on ${name}.`;
    case "failed":
      return `Couldn't check ${name}. Try Check Now.`;
    case "downloading":
      return version ? `Downloading ${app} ${version}…` : t(`Downloading the update…`);
    case "installing":
      return version ? `Installing ${app} ${version}…` : t(`Installing the update…`);
    case "ready":
      return version ? `${app} ${version} is ready. Restart to finish updating.` : t(`Restart to finish updating.`);
    default:
      return null;
  }
}
