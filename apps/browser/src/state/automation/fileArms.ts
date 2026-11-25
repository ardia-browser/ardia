import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { armFilePanel, armsFilePanels as nativeArmsFilePanels, claimArmedDownload, disarmFilePanels, filePanelArms, placeArmedDownload, releaseArmedDownload, type FileArmKind, type FileArmRow } from "../../platform/automation";
import { onDownload, type Download } from "../../platform/downloads";
import { secureRandomHex } from "../../platform/secureRandom";
import { foreignWriteHooks } from "../browser/foreignWriteHooks";
import { engineProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { noteFileArm } from "../telemetry/cliCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { claimDownload, setDownloadClaimant } from "./downloadHooks";
import { STOPPED, type SocketCall } from "./socketCatalog";
import { OpError } from "./workspaceTargets";

export const MAX_UPLOAD_PATHS = 64;
export const MAX_PATH_BYTES = 1024;
export const DEFAULT_ARM_SECONDS = 120;
export const MAX_ARM_SECONDS = 600;
export const MAX_ARMS = 16;
const POLL_MS = 2_000;
const KEEP_ENDED_MS = 600_000;
export const UPLOAD_COPIES_MS = 1_800_000;
export const STAGED_HANDOFF_MS = 3_600_000;
const MARGIN_MS = 60_000;
const STAGING_MARKS = ["/.ardia-", "/download-staging/"];

const keepTrackedFor = (t: Tracked) => (t.kind === "upload" ? UPLOAD_COPIES_MS : STAGED_HANDOFF_MS) + MARGIN_MS;

const armsFilePanels = () => PLATFORM_FEATURES.silentFilePanels && nativeArmsFilePanels();

export const UNSUPPORTED = "Answering file panels for the ardia command needs Ardia on macOS for now.";

export type DownloadProgress = { downloadId: string; state: "downloading" | "finished" | "failed" | "cancelled"; path: string | null; bytes: number; reason?: string; sourceLeft?: true; sourceLeftAt?: string };

type Tracked = {
  id: string;
  kind: FileArmKind;
  tab: string | null;
  engineProfile: string | null;
  before: ReadonlySet<string>;
  once: boolean;
  open: boolean;
  armedAt: number;
  expiresAt: number;
  endedAt: number | null;
  answeredSeen: number;
  failureSeen: boolean;
  downloads: DownloadProgress[];
  consent: ConsentToken | null;
  cleared: boolean;
};

const tracked = new Map<string, Tracked>();
const byDownload = new Map<string, string>();
let downloadsWatched: { remove(): void } | null = null;
const settling = new Set<string>();
let tabsWatched: (() => void) | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

const encoder = new TextEncoder();

export function localPathProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value) return "a path is a non-empty string";
  if (!value.startsWith("/")) return `${value.slice(0, 80)} isn't an absolute path`;
  if (/[\0\r\n]/.test(value)) return "a path can't hold a NUL or a line break";
  if (encoder.encode(value).length > MAX_PATH_BYTES) return `a path is at most ${MAX_PATH_BYTES} bytes`;
  if (value.split("/").some((part) => part === "." || part === "..")) return "a path can't step through . or ..";
  return null;
}

const REASONS: Record<string, string> = {
  notAbsolute: "isn't an absolute path",
  badCharacters: "holds a NUL or a line break",
  tooLong: "is too long",
  traversal: "steps through . or ..",
  missing: "doesn't exist",
  unreadable: "can't be read",
  notAFile: "isn't a regular file",
  folderUpload: "is a folder; only files can be armed for upload",
  stagingFailed: "couldn't be copied for the page to read",
  symlink: "is a symbolic link; name the file itself",
  exists: "already exists; Ardia won't replace a file",
  folderMissing: "is in a folder that doesn't exist",
  notAFolder: "is inside something that isn't a folder",
  folderNotWritable: "is in a folder Ardia can't write to",
  badName: "has a name a file can't take",
};

function armRefusal(reason: string, path?: string, arm?: string): OpError {
  if (reason === "noTab") return new OpError("no_window", "That tab has no page loaded; wake it first.");
  if (reason === "tooMany") return new OpError("refused", `At most ${MAX_ARMS} file arms wait at once; clear some with files.disarm.`);
  if (reason === "onceForFile") return new OpError("bad_request", "A download path names one file; arm again for the next one, or name a folder to keep answering.");
  if (reason === "unsupported") return new OpError("refused", UNSUPPORTED);
  if (reason === "stopped") return new OpError("failed", STOPPED);
  if (reason === "windowBusy") return new OpError("refused", `Upload arm ${arm ?? "another arm"} already waits in this tab's window, and a file chooser names only its window; clear it with files.disarm first.`);
  const why = REASONS[reason];
  if (why) return new OpError("bad_request", `${path ? path.slice(0, 200) : "The path"} ${why}.`);
  return new OpError("failed", `Ardia couldn't arm that (${reason.slice(0, 40)}).`);
}

function sweepTracked(now = Date.now()) {
  for (const [id, t] of tracked) {
    if (t.open && now >= t.expiresAt) {
      t.open = false;
      t.endedAt = now;
    }
    const busy = t.downloads.some((d) => d.state === "downloading");
    if (!t.open && !busy && t.endedAt !== null && now - t.endedAt > Math.max(KEEP_ENDED_MS, keepTrackedFor(t))) {
      tracked.delete(id);
      for (const d of t.downloads) byDownload.delete(d.downloadId);
    }
  }
}

function end(t: Tracked) {
  if (!t.open) return;
  t.open = false;
  t.endedAt = Date.now();
}

function candidates(d: Download): Tracked[] {
  const now = Date.now();
  return [...tracked.values()]
    .filter((t) => t.kind === "download" && !t.cleared && now < t.expiresAt + STAGED_HANDOFF_MS && !t.before.has(d.id))
    .filter((t) => typeof d.startTime !== "number" || Math.floor(d.startTime) >= Math.floor(t.armedAt))
    .filter((t) => t.engineProfile === null || (d.profile ?? "") === t.engineProfile)
    .filter((t) => !t.once || !t.downloads.length)
    .sort((a, b) => Number(b.tab !== null) - Number(a.tab !== null) || b.expiresAt - a.expiresAt);
}

function claim(d: Download): Tracked | null {
  for (const t of candidates(d)) {
    const claimed = claimArmedDownload(t.id, d.id, d.path);
    if (claimed.ok) return t;
  }
  return null;
}

async function settle(t: Tracked, row: DownloadProgress, d: Download, consent: ConsentToken | null) {
  const placed = await placeArmedDownload(t.id, d.id, d.path).catch((error: unknown) => ({ ok: false as const, reason: String(error).slice(0, 80), stagedPath: undefined }));
  if (!placed.ok) {
    row.state = "failed";
    row.reason = placed.reason;
    if (placed.stagedPath) row.path = placed.stagedPath;
    noteFileArm("arm_failures", 1, consent);
    return;
  }
  row.state = "finished";
  row.path = placed.path;
  row.bytes = placed.bytes;
  if (placed.sourceLeft) row.sourceLeft = true;
  if (placed.sourceLeftAt) row.sourceLeftAt = placed.sourceLeftAt;
  noteFileArm("downloads_placed", 1, consent);
  if (placed.path === d.path) return;
  const current = useBrowser.getState().downloads.find((x) => x.id === d.id);
  if (current) foreignWriteHooks.around(() => useBrowser.getState().upsertDownload({ ...current, path: placed.path, filename: placed.path.split("/").pop() || current.filename }));
}

function noteDownload(d: Download) {
  if (d.offTheRecord) return;
  let armId = byDownload.get(d.id);
  if (!armId) {
    const ended = d.state === "failed" || d.state === "cancelled";
    if ((d.state !== "downloading" && d.state !== "finished" && !ended) || !d.path) return;
    if (ended && !STAGING_MARKS.some((mark) => d.path.includes(mark))) return;
    const t = claim(d);
    if (!t) return;
    armId = t.id;
    byDownload.set(d.id, armId);
    t.downloads.push({ downloadId: d.id, state: "downloading", path: null, bytes: 0 });
    claimDownload(d.id);
    if (t.once) end(t);
  }
  const t = tracked.get(armId);
  const row = t?.downloads.find((r) => r.downloadId === d.id);
  if (!t || !row || row.state !== "downloading") return;
  row.bytes = d.received || d.total || row.bytes;
  if (d.path) row.path = d.path;
  if (d.state === "downloading") return;
  if (d.state === "finished") {
    if (d.dangerous || settling.has(d.id)) return;
    settling.add(d.id);
    void settle(t, row, d, t.consent).finally(() => settling.delete(d.id));
    return;
  }
  row.state = d.state;
  releaseArmedDownload(t.id, d.id, d.state);
  noteFileArm("arm_failures", 1, t.consent);
}

function claimsDownload(d: Download): boolean {
  noteDownload(d);
  return byDownload.has(d.id);
}

function watchTabs() {
  if (tabsWatched) return;
  tabsWatched = useBrowser.subscribeTo(["tabs"], (s) => {
    const gone = [...tracked.values()].filter((t) => !t.cleared && t.tab !== null && !s.tabs[t.tab]);
    if (!gone.length) return;
    for (const t of gone) {
      end(t);
      t.cleared = true;
    }
    disarmFilePanels(
      gone.map((t) => t.id),
      true,
    );
  });
}

function account(rows: readonly FileArmRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const t of tracked.values()) {
    const row = byId.get(t.id);
    if (!row) continue;
    if (row.answered > t.answeredSeen) {
      if (t.kind === "upload") noteFileArm("uploads_answered", row.answered - t.answeredSeen, t.consent);
      t.answeredSeen = row.answered;
    }
    if (row.state === "failed" && !t.failureSeen) {
      t.failureSeen = true;
      noteFileArm("arm_failures", 1, t.consent);
    }
    if (row.state !== "armed") end(t);
  }
  sweepTracked();
}

function startPolling() {
  if (poll) return;
  poll = setInterval(() => {
    if (![...tracked.values()].some((t) => t.open)) {
      clearInterval(poll!);
      poll = null;
      return;
    }
    void filePanelArms()
      .then(account)
      .catch(() => undefined);
  }, POLL_MS);
}

export type ArmRequest = { kind: FileArmKind; tab: string | null; profileId: string | null; paths: string[]; once: boolean; seconds: number };

export async function armFiles(request: ArmRequest, call: SocketCall) {
  const consent = consentToken();
  if (!armsFilePanels()) throw new OpError("refused", UNSUPPORTED);
  for (const path of request.paths) {
    const problem = localPathProblem(path);
    if (problem) throw new OpError("bad_request", `${problem}.`);
  }
  sweepTracked();
  const s = useBrowser.getState();
  const windowId = request.tab !== null ? s.tabs[request.tab]?.windowId : undefined;
  const id = `f-${secureRandomHex(16)}`;
  const engine = request.profileId !== null ? engineProfile(s, request.profileId) : null;
  const before = new Set(s.downloads.map((d) => d.id));
  call.stillServing();
  const made = await armFilePanel({ id, kind: request.kind, tab: request.tab, window: windowId ?? null, paths: request.paths, once: request.once, seconds: request.seconds });
  if (!made.ok) throw armRefusal(made.reason, made.path, made.arm);
  if (!call.serving()) {
    disarmFilePanels([id], true);
    call.stillServing();
  }
  if (request.tab !== null && !useBrowser.getState().tabs[request.tab]) {
    disarmFilePanels([id], true);
    throw new OpError("no_window", "The tab closed while Ardia armed it, so nothing is armed.");
  }
  tracked.set(id, {
    id,
    kind: request.kind,
    tab: request.tab,
    engineProfile: engine,
    before,
    once: made.arm.once,
    open: true,
    armedAt: made.arm.armedAt,
    expiresAt: made.arm.expiresAt,
    endedAt: null,
    answeredSeen: 0,
    failureSeen: false,
    downloads: [],
    consent,
    cleared: false,
  });
  noteFileArm(request.kind === "upload" ? "upload_arms" : "download_arms", 1, consent);
  if (request.kind === "download") {
    downloadsWatched ??= onDownload(noteDownload);
    setDownloadClaimant(claimsDownload);
  }
  watchTabs();
  startPolling();
  return armView(made.arm);
}

export function armView(row: FileArmRow) {
  const t = tracked.get(row.id);
  const downloads = t?.downloads.map((d) => ({ ...d })) ?? [];
  const last = downloads[downloads.length - 1];
  const state = row.kind === "download" && last ? last.state : row.kind === "download" && (row.state === "answered" || row.state === "claimed") ? "downloading" : row.state;
  return {
    arm: row.id,
    kind: row.kind,
    tab: row.tab,
    ...(row.kind === "upload" ? { paths: row.paths, chosen: row.landed } : { path: row.paths[0] ?? null, folder: row.folder }),
    once: row.once,
    state,
    ...(row.reason ? { reason: row.reason } : {}),
    armedAt: row.armedAt,
    expiresAt: row.expiresAt,
    answered: row.answered,
    ...(row.kind === "download" ? { downloads } : {}),
  };
}

export async function listArms(only: readonly string[] | null) {
  if (!armsFilePanels()) return { items: [] };
  const rows = await filePanelArms();
  account(rows);
  return { items: rows.filter((r) => only === null || only.includes(r.id)).map(armView) };
}

export async function disarm(only: readonly string[] | null) {
  if (!armsFilePanels()) return { cleared: 0 };
  for (const t of tracked.values()) if (only === null || only.includes(t.id)) end(t);
  return { cleared: disarmFilePanels(only === null ? null : [...only], false) };
}

export function clearFileArms() {
  if (armsFilePanels()) disarmFilePanels(null, true);
  for (const [id, t] of tracked) {
    end(t);
    t.cleared = true;
    if (t.kind === "upload") tracked.delete(id);
  }
  if (poll) clearInterval(poll);
  poll = null;
}

export function resetFileArmsForTests() {
  clearFileArms();
  tracked.clear();
  byDownload.clear();
  downloadsWatched?.remove();
  downloadsWatched = null;
  settling.clear();
  tabsWatched?.();
  tabsWatched = null;
  setDownloadClaimant(null);
}
