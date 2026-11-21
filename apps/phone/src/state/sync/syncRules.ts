import type { ConnectResult, PhraseCheck, SyncedDevice, SyncedProfile, SyncedView, SyncPhase, SyncStatus } from "../../platform/sync.ts";
import { copy } from "../../lib/platformCopy.ts";

export const MAC_HINT = "On your Mac: Settings › General › Sync › Connect Another Device.";
export const YOUR_MAC = "Your Mac";
export const JUST_NOW_MS = 60_000;

export type StatusLine = { text: string; isWarning: boolean };

export const isSyncOff = (status: SyncStatus) => status.phase === "off";

export function isSyncConnected(status: SyncStatus): boolean {
  switch (status.phase) {
    case "starting":
    case "updating":
    case "updated":
    case "stalled":
    case "offline":
    case "needsFolderAccess":
      return status.isEnabled;
    default:
      return false;
  }
}

export function syncRowSubtitle(status: SyncStatus): StatusLine {
  switch (status.attention) {
    case "folder":
      return { text: "Choose Your Sync Folder Again", isWarning: true };
    case "phrase":
      return { text: "Enter Your Recovery Phrase", isWarning: true };
    case "reset":
      return { text: "Out of Sync", isWarning: true };
    case "stalled":
      return { text: status.statusText, isWarning: true };
    default:
      return { text: isSyncOff(status) ? "Every tab, anywhere." : status.statusText, isWarning: false };
  }
}

export function syncHeroSubtitle(status: SyncStatus): StatusLine {
  if (isSyncOff(status)) return { text: copy().syncHero, isWarning: false };
  return { text: status.statusText, isWarning: status.attention !== "none" };
}

export const bannerNeedsAction = (phase: SyncPhase) => phase === "needsFolderAccess" || phase === "locked" || phase === "reset";

export type BannerIcon = "folder" | "lock" | "reset" | "warning" | "offline";

const BANNER_ICONS: Partial<Record<SyncPhase, BannerIcon>> = {
  needsFolderAccess: "folder",
  locked: "lock",
  reset: "reset",
  stalled: "warning",
  offline: "offline",
};

export function syncBanner(status: SyncStatus): { icon: BannerIcon; text: string; needsAction: boolean } | null {
  const icon = BANNER_ICONS[status.phase];
  return icon ? { icon, text: status.statusText, needsAction: bannerNeedsAction(status.phase) } : null;
}

export function connectMessage(result: ConnectResult): string | null {
  switch (result.result) {
    case "connected":
    case "cancelled":
      return null;
    case "invalidPhrase":
      return result.problem;
    case "mismatch":
      return "This recovery phrase doesn’t match the synced data in this folder. Check the phrase, or choose the folder your other devices sync to.";
    case "noSyncData":
      return "There’s no synced data in this folder yet. Choose the folder your other devices sync to, or wait for it to finish downloading.";
    case "folderUnavailable":
      return copy().folderUnavailable;
    case "keyStoreFailed":
      return copy().keySaveFailed;
    case "busy":
      return "Ardia is still turning off sync. Try again in a moment.";
  }
}

export type PhraseTone = "hint" | "problem" | "good";

export function phraseFooter(check: PhraseCheck): { text: string; tone: PhraseTone } {
  if (check.problem) return { text: check.problem, tone: "problem" };
  if (check.isValid) return { text: "All 24 words check out.", tone: "good" };
  return { text: MAC_HINT, tone: "hint" };
}

export const orderedDevices = (devices: readonly SyncedDevice[]): SyncedDevice[] =>
  [...devices].sort((a, b) => Number(a.isCurrent) - Number(b.isCurrent) || (b.lastSeen ?? -Infinity) - (a.lastSeen ?? -Infinity));

const UNITS: [number, string][] = [
  [365 * 86_400, "year"],
  [30 * 86_400, "month"],
  [7 * 86_400, "week"],
  [86_400, "day"],
  [3_600, "hour"],
  [60, "minute"],
];

export function ago(then: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  const [size, unit] = UNITS.find(([span]) => seconds >= span) ?? [1, "second"];
  const count = Math.floor(seconds / size);
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const calendarDay = (at: number) => {
  const date = new Date(at);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
};

export function abbreviatedAgo(then: number, now: number): string {
  const elapsed = Math.max(0, now - then);
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} min. ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr. ago`;
  if (elapsed < 7 * 86_400_000) {
    const days = Math.max(1, calendarDay(now) - calendarDay(then));
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${sameYear ? "" : `, ${date.getFullYear()}`}`;
}

export function deviceSeen(device: SyncedDevice, now: number, othersShowSeen = copy().devicesShowLastSeen): string {
  if (device.isCurrent) return copy().thisDevice;
  if (!othersShowSeen) return "";
  if (device.lastSeen === null) return "Not Yet Synced";
  if (now - device.lastSeen < JUST_NOW_MS) return "Just Now";
  return abbreviatedAgo(device.lastSeen, now);
}

export type DeviceIcon = "phone" | "laptop" | "desktop" | "studio" | "mini";

export function deviceIcon(kind: string, name: string, namesMacModels = copy().devicesNameMacModels): DeviceIcon {
  if (kind === "phone") return "phone";
  const lower = name.toLowerCase();
  if (lower.includes("macbook")) return "laptop";
  if (!namesMacModels || lower.includes("imac")) return "desktop";
  if (lower.includes("studio")) return "studio";
  if (lower.includes("mini")) return "mini";
  return "desktop";
}

export function profileOf(view: SyncedView, id: string | null): SyncedProfile | null {
  return view.profiles.find((p) => p.syncId === id) ?? view.profiles.find((p) => p.isDefault) ?? view.profiles[0] ?? null;
}

export function shownProfile(view: SyncedView, status: Pick<SyncStatus, "isEnabled" | "selectedProfileId">): SyncedProfile | null {
  if (!status.isEnabled) return null;
  const shown = view.shownProfileId ? view.profiles.find((p) => p.syncId === view.shownProfileId) : undefined;
  return shown ?? profileOf(view, status.selectedProfileId ?? view.selectedProfileId);
}

export function sendReceivers(view: SyncedView, profileId: string | null): SyncedDevice[] {
  const profile = view.profiles.find((p) => p.syncId === profileId);
  if (!profile) return [];
  return (profile.sendTargets ?? []).flatMap((id) => view.devices.filter((d) => d.id === id && d.canReceiveTabs && !d.isCurrent));
}

export function receivedSender(senders: readonly (string | null)[]): string {
  const names = new Set(senders.map((name) => name?.trim() ?? "").filter((name) => name.length > 0));
  return names.size === 1 ? [...names][0]! : YOUR_MAC;
}

export const receivedToast = (sender: string, count: number) => (count === 1 ? `Tab from ${sender}` : `${count} Tabs from ${sender}`);

export const sentToast = (device: string) => `Sent to ${device}`;

export const couldNotSendToast = (device: string) => `Couldn’t Send to ${device}`;

export const PINNED_TOAST = "Pinned to Your Mac";
export const COULD_NOT_PIN_TOAST = "Couldn’t Pin to Your Mac";
export const SYNC_TO_PIN_TOAST = "Sync With Your Mac to Pin Tabs";
export const CONNECTED_TOAST = "Syncing With Your Mac";

export function syncedEngineName(
  search: { engineId: string; customEngines: { id: string; name: string }[] },
  engines: readonly { id: string; name: string }[],
): string {
  const custom = search.customEngines.find((engine) => engine.id === search.engineId);
  if (custom) return custom.name;
  if (search.engineId === "custom") return "Custom";
  return engines.find((engine) => engine.id === search.engineId)?.name ?? search.engineId.charAt(0).toUpperCase() + search.engineId.slice(1);
}

export const INBOX_RETRY = "Sync couldn’t read some changes your Mac sent and set that file aside. Sync Now tries again.";

export function inboxNotice(status: SyncStatus): { message: string; footer: string } | null {
  const problem = status.inboxProblem?.trim();
  if (!problem) return null;
  return { message: problem, footer: INBOX_RETRY };
}

export const SCAN_REJECTED = "Not an Ardia sync code.";

export type ScanVerdict = { kind: "accept"; phrase: string } | { kind: "reject" } | { kind: "repeat" };

export function scanJudge(isValid: (payload: string) => boolean) {
  let last: string | null = null;
  return (payload: string): ScanVerdict => {
    if (payload === last) return { kind: "repeat" };
    last = payload;
    return isValid(payload) ? { kind: "accept", phrase: payload.trim() } : { kind: "reject" };
  };
}

export const setupStepLabel = (number: number, done: boolean, current: boolean) => (done ? `Step ${number}, done` : current ? `Step ${number}` : `Step ${number}, later`);

export const pickedFolder = (result: ConnectResult["result"] | null) => result === "mismatch" || result === "noSyncData" || result === "keyStoreFailed";

export const chooseFolderTitle = (lastResult: ConnectResult["result"] | null) => (pickedFolder(lastResult) ? "Choose Another Folder…" : "Choose Folder…");

export type PinOutcome = "pinned" | "alreadyPinned" | "failed";

export type PinAnnouncement = { where: "title"; text: string } | { where: "toast"; text: string; icon: "star" | "warning" };

export function pinAnnouncement(outcome: PinOutcome, inPageMenu: boolean, copy: { pinFeedbackInMenu: boolean; alreadyPinnedToast: string }): PinAnnouncement {
  if (inPageMenu && copy.pinFeedbackInMenu && outcome !== "failed") return { where: "title", text: outcome === "pinned" ? "Pinned to Mac" : "Already Pinned to Mac" };
  if (outcome === "failed") return { where: "toast", text: COULD_NOT_PIN_TOAST, icon: "warning" };
  return { where: "toast", text: outcome === "pinned" ? PINNED_TOAST : copy.alreadyPinnedToast, icon: "star" };
}

export function syncNowFeedback(phase: SyncPhase): "success" | "error" | null {
  if (phase === "updated") return "success";
  if (phase === "stalled" || phase === "offline" || phase === "needsFolderAccess" || phase === "locked" || phase === "reset") return "error";
  return null;
}
