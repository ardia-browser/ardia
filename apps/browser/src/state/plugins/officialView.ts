import type { InstallResult } from "./installWaiters";
import type { OfficialPlugin } from "./official";
import type { ProgramsState } from "./store";

export const wasCancelled = (result: InstallResult) => !result.ok && result.cancelled === true;

export type OfficialAttempt = { state: "asking" } | { state: "installing" } | { state: "failed"; reason: string } | null;

export type OfficialAction = "install" | "turnOn" | "again" | null;

export type OfficialView = {
  shown: boolean;
  note: "installed" | "on" | "comingSoon" | null;
  toggle: boolean;
  status: string | null;
  failed: boolean;
  busy: boolean;
  action: OfficialAction;
  opens: boolean;
  firstCommand: string | null;
};

export const installedLabel = (plugin: OfficialPlugin) => (plugin.version ? `Installed · ${plugin.version}` : "Installed");

const HIDDEN: OfficialView = { shown: false, note: null, toggle: false, status: null, failed: false, busy: false, action: null, opens: false, firstCommand: null };

function installedView(plugin: OfficialPlugin, programs: ProgramsState | undefined, attempt: OfficialAttempt): OfficialView {
  const base = { ...HIDDEN, shown: true, note: "installed" as const, opens: true };
  if (attempt?.state === "installing" || programs?.state === "linking") return { ...base, status: "Installing…", busy: true };
  if (programs?.state === "failed") return { ...base, status: `Not on your PATH: ${programs.reason}`, failed: true, action: "again" };
  if (programs?.state === "linked") {
    const refused = Object.values(programs.refused);
    if (refused.length) return { ...base, status: `Not on your PATH: ${refused.join("; ")}`, failed: true, action: "again" };
    if (programs.adoption === "retrying") return { ...base, status: "Waiting for the old install to finish updating…", busy: true };
    if (programs.adoption === "busy") return { ...base, status: "The old install is busy updating. Try again in a moment.", failed: true, action: "again" };
    if (programs.adoption === "failed") return { ...base, status: "The old install couldn't be switched over to it.", failed: true, action: "again" };
    if (programs.linked.length) return { ...base, firstCommand: plugin.example };
  }
  if (attempt?.state === "failed") return { ...base, status: attempt.reason, failed: true, action: "again" };
  return base;
}

export function officialView(plugin: OfficialPlugin, programs: ProgramsState | undefined, attempt: OfficialAttempt): OfficialView {
  if (plugin.state === "unsupported") return HIDDEN;
  if (plugin.state === "comingSoon") return { ...HIDDEN, shown: true, note: "comingSoon" };
  if (plugin.state === "installed" && plugin.switchable) return { ...installedView(plugin, programs, attempt), note: "on", toggle: true };
  if (plugin.state === "installed") return installedView(plugin, programs, attempt);
  const base = { ...HIDDEN, shown: true, opens: true };
  if (attempt?.state === "asking") return { ...base, busy: true };
  if (attempt?.state === "installing") return { ...base, status: "Installing…", busy: true };
  if (attempt?.state === "failed") return { ...base, status: attempt.reason, failed: true, action: "again" };
  return { ...base, action: plugin.switchable ? "turnOn" : "install" };
}

export const officialTitle = (plugin: OfficialPlugin) => plugin.title || plugin.name;

export const isOffered = (plugin: OfficialPlugin) => plugin.state === "available" || plugin.state === "comingSoon";

export const officialInSettings = (plugins: readonly OfficialPlugin[], name?: string) => plugins.some((p) => p.state !== "unsupported" && (name === undefined || p.name === name));

export const officialNamesInSettings = (plugins: readonly OfficialPlugin[]) => plugins.filter((p) => p.state !== "unsupported").map((p) => p.name);
