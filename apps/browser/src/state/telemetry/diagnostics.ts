import { diagnosticsSample, hardwareInfo, type HardwareInfo } from "../../platform/app";
import { onHoverLost, onWindowUnpainted, systemState, type HoverLostEpisode, type WindowUnpaintedRecord } from "../../platform/performance";
import { cliControlStatus } from "../../platform/cli";
import { call } from "../../platform/engine";
import { withDeadline } from "../../lib/deadline";
import { hermesHeapMegabytes } from "../../lib/hermesHeap";
import { activeTab } from "../browser/model";
import { useBrowser } from "../browser/store";
import { capture, consentNow, consentToken, isSharing, saveContext, stillValid, onConsentPeriodChange } from "./client";
import { nativeConsent } from "./nativeConsent";
import { formatRecentPages, readRecentPages, type RecentPage, type SavedContext } from "./savedContext";
import { noteCliControlStatus } from "./cliStatusCounts";
import { mainProcessWork } from "./mainProcessWork";
import { appInfo } from "./transport";
import { readDocument } from "../../platform/documents";

const CONTEXT_EVERY_MS = 10 * 60_000;
const FIRST_CONTEXT_MS = 3_000;
const HARDWARE_WAIT_MS = 1_000;
const MAX_PAGE_PROCESS_EVENTS = 30;
const MAX_HOVER_LOST_EVENTS = 20;
const MAX_HOVER_LOST_SECONDS = 24 * 60 * 60;
const MAX_WINDOW_UNPAINTED_EVENTS = 20;
const MAX_WINDOW_VIEWS = 1_000;
const MINUTE_MS = 60_000;
const MIN_SAMPLES = 12;
const MAX_SAMPLES = 600;
const MAX_RECENT_PAGES = 3;
const MAX_PAGE_AGE_MIN = 999_999;
const SAMPLE_KEEP_MS = 2 * 60 * 60_000;
const WEBUI_RECORD_GAP_MS = 2_000;

const startedAt = Date.now();
export const sessionStart = () => appInfo().processStart ?? startedAt;
let appMemoryMb: number | null = null;
let pageProcessesGone = 0;
let pageProcessEvents = 0;
let hoverLostEvents = 0;
let windowUnpaintedEvents = 0;
let samples: SavedContext[] = [];
let recentPages: RecentPage[] = [];
let shownPage: string | null = null;
let contextEpoch = 0;
let firstSample: ReturnType<typeof setTimeout> | undefined;
let everySample: ReturnType<typeof setInterval> | undefined;
let unwatchWebuiPage: (() => void) | undefined;
let webuiRecord: ReturnType<typeof setTimeout> | undefined;
let lastWebuiRecordAt = 0;

const size = (o: object) => Object.keys(o).length;
const sessionMinutes = (at = Date.now()) => Math.max(0, Math.round((at - sessionStart()) / MINUTE_MS));

function counts() {
  const s = useBrowser.getState();
  return { tabs: size(s.tabs), windows: size(s.windows), profiles: size(s.profiles) };
}

async function memoryPressure(): Promise<string | null> {
  const state = await withDeadline(systemState(), HARDWARE_WAIT_MS, null).catch(() => null);
  return state?.memoryPressure ?? null;
}

const WEBUI_PAGE = /^(?:ardia|chrome):\/\/([a-z0-9-]{1,32})(?:\/([a-z0-9-]{1,32}))?(?=[/?#]|$)/i;

export function webuiPage(url: string | null | undefined): string | null {
  const m = url ? WEBUI_PAGE.exec(url) : null;
  return m ? (m[2] ? `${m[1]}/${m[2]}` : m[1]!).toLowerCase() : null;
}

function activeWebuiPage(s = useBrowser.getState()): string | null {
  const windowId = s.ui.focusOrder.find((id) => s.windows[id]) ?? s.windowOrder[0];
  return webuiPage(windowId ? activeTab(s, windowId)?.url : null);
}

const roughGigabytes = (gb: number | undefined) => (gb === undefined ? null : gb < 10 ? Math.round(gb * 10) / 10 : Math.round(gb));

function noteWebuiPage(page: string, at: number) {
  recentPages = [{ page, at }, ...recentPages.filter((p) => p.page !== page)].slice(0, MAX_RECENT_PAGES);
}

export const noteAppMemory = (totalMb: number) => (appMemoryMb = totalMb);

export async function recordContext(): Promise<SavedContext | null> {
  const consent = consentToken();
  if (!consent) return null;
  void cliControlStatus().then((status) => noteCliControlStatus(status, consent), () => {});
  const epoch = contextEpoch;
  const [sample, pressure] = await Promise.all([diagnosticsSample().catch(() => ({ footprintMB: undefined, freeDiskGB: undefined })), memoryPressure()]);
  if (!stillValid(consent) || epoch !== contextEpoch) return null;
  const now = Date.now();
  const page = activeWebuiPage();
  if (page) noteWebuiPage(page, now);
  const context: SavedContext = {
    at: now,
    session_start: sessionStart(),
    ...counts(),
    footprint_mb: sample.footprintMB ?? null,
    app_memory_mb: appMemoryMb,
    free_disk_gb: roughGigabytes(sample.freeDiskGB),
    memory_pressure: pressure,
    page_processes_gone: pageProcessesGone,
    webui_page: page,
    webui_pages: formatRecentPages(recentPages),
    hermes_heap_mb: hermesHeapMegabytes(),
  };
  if (!isSharing()) return null;
  samples = keepRecent([...samples, context], now);
  saveContext(context);
  return context;
}

function keepRecent(list: SavedContext[], now: number): SavedContext[] {
  const recent = list.filter((c) => now - (c.at as number) < SAMPLE_KEEP_MS);
  return (recent.length >= MIN_SAMPLES ? recent : list.slice(-MIN_SAMPLES)).slice(-MAX_SAMPLES);
}

let reads: Promise<unknown> = Promise.resolve();

function inTurn<T>(read: () => Promise<T>): Promise<T> {
  const next = reads.then(read, read);
  reads = next.catch(() => null);
  return next;
}

export const takeMainProcessWork = () => inTurn(async () => mainProcessWork(await diagnosticsSample().catch(() => ({})), Date.now()));

export const takeContentDriftCounts = (): Promise<Record<string, number>> =>
  inTurn(async (): Promise<Record<string, number>> => {
    const drift = await call("webView.takeContentDrift", {}).catch(() => null);
    if (!drift) return {};
    return { content_layer_layouts: drift.layouts, content_layer_refits: drift.fits, content_layer_drift_max_pt: drift.maxPoints };
  });

export const takeColdTabHoldCounts = (): Promise<Record<string, number>> =>
  inTurn(async (): Promise<Record<string, number>> => {
    const holds = await call("webView.takeFirstPaintHolds", {}).catch(() => null);
    if (!holds) return {};
    return {
      cold_tab_holds: holds.held,
      cold_tab_holds_painted: holds.painted,
      cold_tab_holds_loaded: holds.loaded,
      cold_tab_holds_pressed: holds.pressed,
      cold_tab_holds_timed_out: holds.timedOut,
      cold_tab_hold_ms: holds.heldMs,
    };
  });

export const contextSamples = () => samples;

function forgetContext() {
  contextEpoch++;
  samples = [];
  recentPages = [];
  shownPage = null;
  appMemoryMb = null;
  pageProcessesGone = 0;
}

onConsentPeriodChange(() => {
  forgetContext();
  hoverLostEvents = windowUnpaintedEvents = 0;
});

useBrowser.subscribe((s, prev) => {
  if (s.profiles === prev.profiles || size(s.profiles) >= size(prev.profiles)) return;
  forgetContext();
  saveContext(null);
});

function recordForWebuiPage() {
  if (webuiRecord !== undefined) return;
  const wait = Math.max(0, lastWebuiRecordAt + WEBUI_RECORD_GAP_MS - Date.now());
  webuiRecord = setTimeout(() => {
    webuiRecord = undefined;
    lastWebuiRecordAt = Date.now();
    void recordContext();
  }, wait);
}

function watchWebuiPage() {
  shownPage = activeWebuiPage();
  unwatchWebuiPage = useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs && s.windows === prev.windows && s.ui === prev.ui) return;
    const page = activeWebuiPage(s);
    if (page === shownPage) return;
    if (shownPage && isSharing()) noteWebuiPage(shownPage, Date.now());
    shownPage = page;
    recordForWebuiPage();
  });
}

export function startContextSamples() {
  stopContextSamples();
  firstSample = setTimeout(() => void recordContext(), FIRST_CONTEXT_MS);
  everySample = setInterval(() => void recordContext(), CONTEXT_EVERY_MS);
  watchWebuiPage();
}

export function stopContextSamples() {
  clearTimeout(firstSample);
  clearInterval(everySample);
  clearTimeout(webuiRecord);
  unwatchWebuiPage?.();
  firstSample = everySample = webuiRecord = unwatchWebuiPage = undefined;
}

const CONTEXT_FIELDS = ["tabs", "windows", "profiles", "footprint_mb", "app_memory_mb", "free_disk_gb", "memory_pressure", "page_processes_gone", "webui_page", "hermes_heap_mb"] as const;

export function contextProperties(context: SavedContext | null, prefix: string, at: number): Record<string, unknown> {
  if (!context || typeof context.at !== "number") return {};
  const out: Record<string, unknown> = {};
  for (const key of CONTEXT_FIELDS) out[`${prefix}${key}`] = context[key] ?? null;
  const start = typeof context.session_start === "number" ? context.session_start : null;
  out[`${prefix}session_min`] = start === null ? null : Math.max(0, Math.round((context.at - start) / MINUTE_MS));
  out[`${prefix}age_min`] = Math.max(0, Math.round((at - context.at) / MINUTE_MS));
  return out;
}

const startOf = (c: SavedContext | null) => (c && typeof c.session_start === "number" && typeof c.at === "number" ? c.session_start : null);

export function recentWebuiPages(context: SavedContext | null, at: number): string | null {
  const pages = readRecentPages(context?.webui_pages);
  if (!pages.length) return null;
  return pages.map((p) => `${p.page}:${Math.min(Math.max(0, Math.round((at - p.at) / MINUTE_MS)), MAX_PAGE_AGE_MIN)}`).join(",");
}

export function contextAt(contexts: (SavedContext | null)[], at: number, sessionStarts: number[]): SavedContext | null {
  const starts = [...sessionStarts, ...contexts.map(startOf)].filter((start): start is number => start !== null && start <= at);
  if (!starts.length) return null;
  const session = Math.max(...starts);
  let best: SavedContext | null = null;
  for (const c of contexts) {
    if (startOf(c) !== session || (c!.at as number) > at) continue;
    if (!best || (c!.at as number) >= (best.at as number)) best = c;
  }
  return best;
}

const chipName = (chip: string) => chip.split(" @ ", 1)[0]!.replace(/\(R\)|\(TM\)/g, "").replace(/\s+/g, " ").trim();

export async function hardwareProperties(): Promise<Record<string, unknown>> {
  const info: HardwareInfo | null = await withDeadline(hardwareInfo(), HARDWARE_WAIT_MS, null).catch(() => null);
  if (!info) return {};
  return {
    chip: chipName(info.chip) || null,
    gpu: info.gpu ? chipName(info.gpu) : null,
    memory_gb: info.memoryGB,
    displays: info.displays,
    max_scale: Math.round(info.maxScale * 100) / 100,
    hw_decode_av1: info.hardwareDecode.av1,
    hw_decode_vp9: info.hardwareDecode.vp9,
    hw_decode_hevc: info.hardwareDecode.hevc,
    hw_decode_h264: info.hardwareDecode.h264,
  };
}

const GONE_REASONS = new Set(["abnormal", "killed", "crashed", "oom", "launchFailed", "integrity", "unknown"]);

export type PageTranslateContext = { translate: string; translate_stage: string | null; translating_tabs: number; translated_tabs: number };

export function trackPageProcessGone(info: { reason: string; code: number }, visible: boolean, translate?: PageTranslateContext) {
  const consent = consentNow();
  pageProcessesGone++;
  if (pageProcessEvents >= MAX_PAGE_PROCESS_EVENTS) return;
  pageProcessEvents++;
  const reason = GONE_REASONS.has(info.reason) ? info.reason : "unknown";
  const props = {
    process: "renderer",
    reason,
    exit_code: Number.isSafeInteger(info.code) ? info.code : null,
    visible,
    ...translate,
    ...counts(),
    session_min: sessionMinutes(),
    gone_this_session: pageProcessesGone,
  };
  void memoryPressure().then((memory_pressure) => capture("page_process_gone", { ...props, memory_pressure }, consent));
}

const HOVER_REASONS = new Set(["halfActive", "staleMenu", "notKeyOrMain", "coveredByView", "responderLost", "coveredByWindow"]);
const HOVER_RESPONDERS = new Set(["none", "window", "otherWindow", "page", "control"]);
const HOVER_WINDOW_KINDS = new Set(["none", "hidden", "blockerPage", "internal", "ardiaPanel", "popup", "browser", "other"]);
const HOVER_COVERS = new Set(["none", "reactNative", "chromium", "other"]);
const HOVER_ENDINGS = new Set(["hover", "heal", "appInactive", "windowClosed"]);

const oneOf = (allowed: Set<string>, value: unknown) => (typeof value === "string" && allowed.has(value) ? value : "unknown");

export function hoverLostProperties(e: HoverLostEpisode) {
  return {
    reason: oneOf(HOVER_REASONS, e.reason),
    trigger: e.trigger === "click" ? "click" : "move",
    key_window: oneOf(HOVER_WINDOW_KINDS, e.keyWindow),
    main_window: oneOf(HOVER_WINDOW_KINDS, e.mainWindow),
    prevent_key: e.preventKey === true,
    can_key: e.canKey === true,
    window_main: e.windowMain === true,
    half_active: e.halfActive === true,
    app_active: e.appActive === true,
    running_active: e.runningActive === true,
    frontmost: e.frontmost === true,
    menu_active: e.menuActive === true,
    over_page: e.overPage === true,
    cover: oneOf(HOVER_COVERS, e.cover),
    cover_clear: e.coverClear === true,
    responder: oneOf(HOVER_RESPONDERS, e.responder),
    cover_window: oneOf(HOVER_WINDOW_KINDS, e.coverWindow ?? "none"),
    healed: e.healed === true,
    heal_worked: typeof e.healWorked === "boolean" ? e.healWorked : null,
    ended_by: oneOf(HOVER_ENDINGS, e.endedBy),
    lost_seconds: Number.isFinite(e.seconds) ? Math.min(Math.max(0, Math.round(e.seconds)), MAX_HOVER_LOST_SECONDS) : null,
    session_min: sessionMinutes(),
  };
}

export function trackHoverLost(e: HoverLostEpisode) {
  const consent = nativeConsent(e);
  if (hoverLostEvents >= MAX_HOVER_LOST_EVENTS) return;
  const valid = stillValid(consent);
  if (valid) hoverLostEvents++;
  capture("page_hover_lost", { ...hoverLostProperties(e), episode: valid ? hoverLostEvents : null }, consent);
}

const UNPAINTED_WINDOWS = new Set(["regular", "private"]);
const UNPAINTED_TRIGGERS = new Set(["seen", "key"]);
const UNPAINTED_OCCLUSIONS = new Set(["visible", "occluded"]);

const cappedCount = (value: unknown) => (Number.isFinite(value) ? Math.min(Math.max(0, Math.round(value as number)), MAX_WINDOW_VIEWS) : null);
const hasBit = (bits: unknown, bit: number) => typeof bits === "number" && Number.isSafeInteger(bits) && (bits & (1 << bit)) !== 0;

export function windowUnpaintedProperties(r: WindowUnpaintedRecord) {
  return {
    window: oneOf(UNPAINTED_WINDOWS, r.window),
    trigger: oneOf(UNPAINTED_TRIGGERS, r.trigger),
    seen: r.seen === true,
    occlusion: oneOf(UNPAINTED_OCCLUSIONS, r.occlusion),
    overruled: r.overruled === true,
    app_active: r.appActive === true,
    windows: cappedCount(r.windows),
    share_tabs: !!useBrowser.getState().settings?.shareTabsAcrossWindows,
    views: cappedCount(r.views),
    unpainted: cappedCount(r.unpainted),
    alpha_zero: hasBit(r.reasons, 0),
    view_hidden: hasBit(r.reasons, 1),
    page_hidden: hasBit(r.reasons, 2),
    page_detached: hasBit(r.reasons, 3),
    frame_hold_awaiting: hasBit(r.reasons, 4),
    stand_in_lent: hasBit(r.reasons, 5),
    stand_in_leaving: hasBit(r.reasons, 6),
    veil_up: hasBit(r.reasons, 7),
    session_min: sessionMinutes(),
  };
}

export function trackWindowUnpainted(r: WindowUnpaintedRecord) {
  const consent = nativeConsent(r);
  if (windowUnpaintedEvents >= MAX_WINDOW_UNPAINTED_EVENTS) return;
  if (stillValid(consent)) windowUnpaintedEvents++;
  capture("window_unpainted", windowUnpaintedProperties(r), consent);
}

export function watchEngineReports() {
  onHoverLost(trackHoverLost);
  onWindowUnpainted(trackWindowUnpainted);
}

export const LAUNCH_GUARD_DOC = "launch-guard.json";

type LaunchGuardProperties = {
  launch_waited_for_previous_ms?: number;
  launch_unfinished_starts_before?: number;
  launch_restore_state_set_aside?: boolean;
  launch_profile_held_by_another?: boolean;
};

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

export function launchGuardProperties(read: (name: string) => string | null = readDocument): LaunchGuardProperties {
  let saved: unknown;
  try {
    const raw = read(LAUNCH_GUARD_DOC);
    if (!raw) return {};
    saved = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!saved || typeof saved !== "object") return {};
  const facts = saved as Record<string, unknown>;
  const properties: LaunchGuardProperties = {};
  const waited = count(facts.waitedForPreviousMs);
  const unfinished = count(facts.unfinishedStartsBefore);
  if (waited !== undefined) properties.launch_waited_for_previous_ms = waited;
  if (unfinished !== undefined) properties.launch_unfinished_starts_before = unfinished;
  if (typeof facts.restoreStateSetAside === "boolean") properties.launch_restore_state_set_aside = facts.restoreStateSetAside;
  if (typeof facts.profileHeldByAnother === "boolean") properties.launch_profile_held_by_another = facts.profileHeldByAnother;
  return properties;
}
