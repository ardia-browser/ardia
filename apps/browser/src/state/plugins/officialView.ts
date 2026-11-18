import type { InstallResult } from "./installWaiters";
import type { OfficialPlugin } from "./official";
import type { ProgramsState } from "./store";

export const CANCELLED_REASON = "Cancelled.";

export const wasCancelled = (result: InstallResult) => !result.ok && result.reason === CANCELLED_REASON;

export type OfficialAttempt = { state: "asking" } | { state: "installing" } | { state: "failed"; reason: string } | null;

export type OfficialAction = "install" | "again" | null;

export type OfficialView = {
  shown: boolean;
  note: "installed" | "comingSoon" | null;
  status: string | null;
  failed: boolean;
  busy: boolean;
  action: OfficialAction;
  opens: boolean;
  firstCommand: { command: string; does: string } | null;
};

const FIRST_COMMANDS: Record<string, { command: string; does: string }> = {
  cli: { command: "ardia tabs", does: "Lists your open tabs. Run it in your terminal." },
};

const HIDDEN: OfficialView = { shown: false, note: null, status: null, failed: false, busy: false, action: null, opens: false, firstCommand: null };

const failure = (reason: string | undefined) => `Couldn't install it: ${reason ?? "something went wrong."}`;

function installedView(plugin: OfficialPlugin, programs: ProgramsState | undefined, attempt: OfficialAttempt): OfficialView {
  const base = { ...HIDDEN, shown: true, note: "installed" as const, opens: true };
  if (attempt?.state === "installing" || programs?.state === "linking") return { ...base, status: "Putting its command on your PATH…", busy: true };
  if (programs?.state === "failed") return { ...base, status: `Its command couldn't go on your PATH: ${programs.reason}`, failed: true, action: "again" };
  if (programs?.state === "linked") {
    const refused = Object.values(programs.refused);
    if (refused.length) return { ...base, status: refused.join("; "), failed: true, action: "again" };
    if (programs.linked.length) return { ...base, status: `${programs.linked.join(", ")} is on your PATH (${programs.binDir})`, firstCommand: FIRST_COMMANDS[plugin.name] ?? null };
  }
  if (attempt?.state === "failed") return { ...base, status: failure(attempt.reason), failed: true, action: "again" };
  return base;
}

export function officialView(plugin: OfficialPlugin, programs: ProgramsState | undefined, attempt: OfficialAttempt): OfficialView {
  if (plugin.state === "unsupported") return HIDDEN;
  if (plugin.state === "comingSoon") return { ...HIDDEN, shown: true, note: "comingSoon" };
  if (plugin.state === "installed") return installedView(plugin, programs, attempt);
  const base = { ...HIDDEN, shown: true, opens: true };
  if (attempt?.state === "asking") return { ...base, busy: true };
  if (attempt?.state === "installing") return { ...base, status: "Installing…", busy: true };
  if (attempt?.state === "failed") return { ...base, status: failure(attempt.reason), failed: true, action: "again" };
  return { ...base, action: "install" };
}

export const officialTitle = (plugin: OfficialPlugin) => plugin.title || plugin.name;

export const isOffered = (plugin: OfficialPlugin) => plugin.state === "available" || plugin.state === "comingSoon";
