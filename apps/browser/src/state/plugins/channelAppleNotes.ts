import type { PluginManifest } from "../../lib/pluginManifest";
import { confirm } from "../../platform/dialogs";
import { appleNotesFolders, appleNotesNotes } from "../../platform/files";
import { failure } from "../automation/automationMethods";
import { lastFocusedEligibleWindow } from "../automation/automationWindows";
import type { Body } from "../automation/controlSocket";
import { useBrowser } from "../browser/store";
import { consentToken } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { acceptsRun, onProcessStopped } from "./process";

export const APPLE_NOTES_METHODS = ["appleNotes.request", "appleNotes.folders", "appleNotes.notes"] as const;

export const APPLE_NOTES_LIMITS = { notesPerCall: 200, folders: 2000, bodyChars: 8 * 1024 * 1024, nameChars: 2000, idChars: 512 } as const;

const NOT_ALLOWED = -1743;
const granted = new Map<string, number>();
const asking = new Set<string>();
let listening = false;

type Caller = { name: string; run: number };

export type AppleNotesFolder = { id: string; name: string; account: string; parent: string; count: number };
export type AppleNotesNote = { id: string; name: string; created: number; modified: number; locked: boolean; body: string };

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

export function cleanFolders(raw: unknown): AppleNotesFolder[] {
  if (!Array.isArray(raw)) return [];
  const out: AppleNotesFolder[] = [];
  for (const f of raw.slice(0, APPLE_NOTES_LIMITS.folders)) {
    if (typeof f !== "object" || f === null) continue;
    const r = f as Record<string, unknown>;
    const id = text(r.id, APPLE_NOTES_LIMITS.idChars);
    if (!id) continue;
    out.push({ id, name: text(r.name, APPLE_NOTES_LIMITS.nameChars), account: text(r.account, APPLE_NOTES_LIMITS.nameChars), parent: text(r.parent, APPLE_NOTES_LIMITS.idChars), count: count(r.count) });
  }
  return out;
}

export function cleanNotes(raw: unknown): { total: number; notes: AppleNotesNote[] } {
  if (typeof raw !== "object" || raw === null) return { total: 0, notes: [] };
  const r = raw as Record<string, unknown>;
  const notes: AppleNotesNote[] = [];
  for (const n of Array.isArray(r.notes) ? r.notes.slice(0, APPLE_NOTES_LIMITS.notesPerCall) : []) {
    if (typeof n !== "object" || n === null) continue;
    const x = n as Record<string, unknown>;
    const id = text(x.id, APPLE_NOTES_LIMITS.idChars);
    if (!id) continue;
    const locked = x.locked === true;
    notes.push({ id, name: text(x.name, APPLE_NOTES_LIMITS.nameChars), created: time(x.created), modified: time(x.modified), locked, body: locked ? "" : text(x.body, APPLE_NOTES_LIMITS.bodyChars) });
  }
  return { total: count(r.total), notes };
}

function listen() {
  if (listening) return;
  listening = true;
  onProcessStopped((name) => void granted.delete(name));
}

function answerOf(answer: { ok: boolean; json?: string; error?: string; code?: number }): { ok: true; value: unknown } | { ok: false; body: Body } {
  if (!answer || answer.ok !== true) {
    if (answer?.code === NOT_ALLOWED) return { ok: false, body: failure("refused", "macOS didn't let Ardia read Notes. Turn Ardia on for Notes in System Settings › Privacy & Security › Automation, then try again.") };
    return { ok: false, body: failure("unavailable", typeof answer?.error === "string" && answer.error ? answer.error.slice(0, 300) : "Notes didn't answer.") };
  }
  try {
    return { ok: true, value: JSON.parse(answer.json ?? "") };
  } catch {
    return { ok: false, body: failure("failed", "Notes answered something Ardia couldn't read.") };
  }
}

async function request(c: Caller, m: PluginManifest): Promise<Body> {
  listen();
  if (granted.get(c.name) === c.run) return { result: { granted: true } };
  if (asking.has(c.name)) return failure("failed", "This plugin is already asking about Notes. Wait for that answer first.");
  const windowId = lastFocusedEligibleWindow(useBrowser.getState());
  if (!windowId) return failure("no_window", "No window to ask in.");
  asking.add(c.name);
  const consent = consentToken();
  notePlugin("plugin_apple_notes_asks", consent);
  try {
    const answer = await confirm({
      title: `${m.title} wants to read your Apple Notes`,
      message: `It copies your notes' titles, text, pictures, folders and dates into ${m.title}, in Ardia on this Mac. Nothing is sent anywhere, Apple Notes isn't changed, and locked notes are skipped. Next, macOS asks you to let Ardia control the Notes app.`,
      confirmTitle: "Allow",
      windowId,
      sheetOnly: true,
    });
    if (answer.unavailable === true) return failure("no_window", "No visible window to show the dialog.");
    if (answer.confirmed !== true) return { result: { granted: false } };
    if (!acceptsRun(c.name, c.run)) return failure("refused", "The plugin stopped while you were deciding.");
    granted.set(c.name, c.run);
    notePlugin("plugin_apple_notes_allowed", consent);
    return { result: { granted: true } };
  } finally {
    asking.delete(c.name);
  }
}

export async function appleNotesMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Promise<Body> {
  if (method === "appleNotes.request") return request(c, m);
  const consent = consentToken();
  if (granted.get(c.name) !== c.run) return failure("refused", "Ask with appleNotes.request first; the person allows it for this run of the plugin.");
  if (method === "appleNotes.folders") {
    const answer = answerOf(await appleNotesFolders());
    if (!answer.ok) return answer.body;
    notePlugin("plugin_apple_notes_reads", consent);
    return { result: { folders: cleanFolders(answer.value) } };
  }
  const folder = params.folder;
  if (typeof folder !== "string" || !folder || folder.length > APPLE_NOTES_LIMITS.idChars) return failure("bad_request", "folder is an id from appleNotes.folders.");
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return failure("bad_request", "offset is a whole number, 0 or more.");
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > APPLE_NOTES_LIMITS.notesPerCall) return failure("bad_request", `limit is 1 to ${APPLE_NOTES_LIMITS.notesPerCall}.`);
  const answer = answerOf(await appleNotesNotes(folder, offset, limit));
  if (!answer.ok) return answer.body;
  notePlugin("plugin_apple_notes_reads", consent);
  return { result: cleanNotes(answer.value) };
}
