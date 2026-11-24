import type { InstallResult } from "./installWaiters";
import type { OfficialPlugin } from "./official";
import type { OfficialAutoUpdate, OfficialFetch, ProgramsState } from "./store";

export const wasCancelled = (result: InstallResult) => !result.ok && result.cancelled === true;

export type OfficialAttempt = { state: "asking" } | { state: "installing" } | { state: "failed"; reason: string } | null;

type OfficialAction = "install" | "again" | "update" | null;

type OfficialView = {
  shown: boolean;
  note: "installed" | "comingSoon" | null;
  status: string | null;
  failed: boolean;
  busy: boolean;
  action: OfficialAction;
  opens: boolean;
  firstCommand: string | null;
};

export const installedLabel = (plugin: OfficialPlugin) => (plugin.version ? `Installed · ${plugin.version}` : "Installed");

const HIDDEN: OfficialView = { shown: false, note: null, status: null, failed: false, busy: false, action: null, opens: false, firstCommand: null };

function downloadStatus(fetch: OfficialFetch | undefined): string | null {
  if (fetch?.state === "promoting") return "Installing…";
  if (fetch?.state !== "fetching") return null;
  return fetch.total > 0 ? `Downloading… ${Math.min(100, Math.floor((fetch.received / fetch.total) * 100))}%` : "Downloading…";
}

function installedView(plugin: OfficialPlugin, programs: ProgramsState | undefined, attempt: OfficialAttempt, fetch: OfficialFetch | undefined): OfficialView {
  const base = { ...HIDDEN, shown: true, note: "installed" as const, opens: true };
  const downloading = downloadStatus(fetch);
  if (downloading) return { ...base, status: downloading, busy: true };
  if (attempt?.state === "installing" || programs?.state === "linking") return { ...base, status: "Installing…", busy: true };
  if (programs?.state === "failed") return { ...base, status: `Not on your PATH: ${programs.reason}`, failed: true, action: "again" };
  if (plugin.update) {
    if (attempt?.state === "failed") return { ...base, status: attempt.reason, failed: true, action: "update" };
    return { ...base, status: `Version ${plugin.update} is ready. Review what it gets to update.`, action: "update" };
  }
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

const olderInstallLine = (plugin: OfficialPlugin, program: string) => `An older ${program} is installed. Install ${officialTitle(plugin)} to update it.`;

export function officialView(plugin: OfficialPlugin, programs: ProgramsState | undefined, attempt: OfficialAttempt, fetch?: OfficialFetch, olderProgram: string | null = null): OfficialView {
  if (plugin.state === "unsupported") return HIDDEN;
  if (plugin.state === "comingSoon") return { ...HIDDEN, shown: true, note: "comingSoon" };
  if (plugin.state === "installed") return installedView(plugin, programs, attempt, fetch);
  const base = { ...HIDDEN, shown: true, opens: true };
  const downloading = downloadStatus(fetch);
  if (downloading) return { ...base, status: downloading, busy: true };
  if (attempt?.state === "asking") return { ...base, busy: true };
  if (attempt?.state === "installing") return { ...base, status: "Installing…", busy: true };
  if (attempt?.state === "failed") return { ...base, status: attempt.reason, failed: true, action: "again" };
  return { ...base, action: "install", status: olderProgram ? olderInstallLine(plugin, olderProgram) : null };
}

export function autoUpdateNote(updated: OfficialAutoUpdate): { title: string; description: string } {
  const title = updated.to ? `Updated by itself to ${updated.to}` : "Updated by itself";
  const said = updated.runtime
    ? "It added its own code, which runs in Ardia's sandbox, offline, and first starts when you use one of its commands in the command bar. Its permissions didn't change."
    : "Its permissions didn't change.";
  const since = updated.from ? `New since ${updated.from}` : "New since the version you approved";
  return { title, description: updated.added.length ? `${said} ${since}: ${updated.added.join("; ")}.` : said };
}

export const officialTitle =(plugin: OfficialPlugin) => plugin.title || plugin.name;

export const isOffered = (plugin: OfficialPlugin) => plugin.state === "available" || plugin.state === "comingSoon";

export const officialInSettings = (plugins: readonly OfficialPlugin[], name?: string) => plugins.some((p) => p.state !== "unsupported" && (name === undefined || p.name === name));

export const officialNamesInSettings = (plugins: readonly OfficialPlugin[]) => plugins.filter((p) => p.state !== "unsupported").map((p) => p.name);
