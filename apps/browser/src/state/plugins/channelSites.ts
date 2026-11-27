import { isFields } from "../../lib/decode";
import type { PluginManifest } from "../../lib/pluginManifest";
import { filesCall, filesRevoke, filesTicket, sendToPlugin } from "../../platform/plugins";
import { secureRandomHex } from "../../platform/secureRandom";
import { useBrowser } from "../browser/store";
import { engineProfile } from "../browser/model";
import { failure, type ErrorCode } from "../automation/automationMethods";
import { eligibleKind, lastFocusedEligibleWindow } from "../automation/automationWindows";
import type { Body } from "../automation/controlSocket";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { pathProblem } from "./channelFiles";
import { updateRecord } from "./lifecycle";
import { acceptsRun, onProcessStopped } from "./process";
import { DOWNLOAD_CANCEL, DOWNLOAD_NEXT, DOWNLOAD_START, FETCH_SCRIPT, KEPT_RESPONSE_HEADERS } from "./siteScripts";
import { cleanHeaders, decodedBytes, fileFailure, siteHeadersOf, siteTarget, stageId, utf8Bytes, type SitePlace, type SiteTarget, type SiteTransport } from "./siteRules";
import { activeManifest, currentPlugins, NO_RECORD, recordOf } from "./store";
import { isOfficialFolder } from "./appChecks";
import { hiddenPageTransport } from "./siteContexts";
import { admit, SITES_LIMITS, takeToken } from "./siteBudget";
import { SITES_TRANSPORT_OFF_REASON, sitesTransportOn } from "./siteSwitch";

export { decodedBytes, siteHeadersOf, siteTarget } from "./siteRules";
export { activeSiteRequests, SITES_LIMITS, takeToken } from "./siteBudget";

export const SITES_METHODS = ["sites.available", "sites.fetch", "sites.download", "sites.cancel", "sites.status", "sites.session"] as const;

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const SIGNED_OUT_OFF = "You turned off this plugin's use of your sign-in in Settings › Plugins.";
const ENDED = "The plugin stopped, or its use of your sign-in was turned off.";
const NO_TRANSPORT = "Only Ardia's own official plugins can use your sign-in on a site in this version of Ardia.";

type Caller = { name: string; run: number };
type Op = { caller: Caller; generation: number };
type DownloadState = { download: string; state: "running" | "done" | "failed" | "cancelled"; received: number; total?: number; size?: number; code?: string; error?: string };
type Download = Op & { id: string; to: string; stage: string; cancelled: boolean; key: string | null; halt: () => void; halted: Promise<void>; last: DownloadState };
type Session = SitePlace & { plugin: string; run: number };

let transport: SiteTransport | null = null;
const generations = new Map<string, number>();
const downloads = new Map<string, Download>();
const ended = new Map<string, Map<string, DownloadState>>();
const sessions = new Map<string, Session>();

export const setSiteTransport = (next: SiteTransport | null) => void (transport = next);

const isBuiltInOfficial = (name: string) => {
  const listing = currentPlugins().listings[name];
  return !!listing?.manifest && isOfficialFolder(listing.folderId);
};

export const transportFor = (name: string): SiteTransport | null => (transport && sitesTransportOn() && isBuiltInOfficial(name) ? transport : null);

export const signInOn = (name: string) => recordOf(currentPlugins(), name).sitesOff !== true;

const generationOf = (name: string) => generations.get(name) ?? 0;

const invalidate = (name: string) => void generations.set(name, generationOf(name) + 1);

const opOf = (c: Caller): Op => ({ caller: c, generation: generationOf(c.name) });

function placeHolds(place: SitePlace): boolean {
  const s = useBrowser.getState();
  return !!eligibleKind(s, place.windowId) && engineProfile(s, s.windows[place.windowId]!.profileId) === place.profile;
}

const stillAllowed = (op: Op, place: SitePlace, needsFiles = false) => {
  const m = activeManifest(currentPlugins(), op.caller.name);
  return acceptsRun(op.caller.name, op.caller.run) && !!m && m.permissions.sites.length > 0 && (!needsFiles || m.permissions.files) && signInOn(op.caller.name) && generationOf(op.caller.name) === op.generation && placeHolds(place);
};

function refused(message: string, consent: ConsentToken | null): Body {
  notePlugin("plugin_site_refusals", consent);
  return failure("refused", message);
}

function currentPlace(): SitePlace | Body {
  const s = useBrowser.getState();
  const windowId = lastFocusedEligibleWindow(s);
  if (!windowId || !eligibleKind(s, windowId)) return failure("no_window", "Open a regular (not private) Ardia window to use your sign-in.");
  return { profile: engineProfile(s, s.windows[windowId]!.profileId), windowId };
}

function sessionPlace(c: Caller, raw: unknown): SitePlace | Body {
  if (raw === undefined) return currentPlace();
  const found = typeof raw === "string" ? sessions.get(raw) : undefined;
  if (!found || found.plugin !== c.name || found.run !== c.run) return failure("refused", "That sign-in session isn't this run's; start a new one with sites.session.");
  if (!placeHolds(found)) return failure("no_window", "The window that session belongs to closed or changed profile.");
  return { profile: found.profile, windowId: found.windowId };
}

const isBody = (value: unknown): value is Body => isFields(value) && ("result" in value || "error" in value);

const ERRORS: Record<string, [ErrorCode, string]> = {
  origin: ["failed", "The site's page in Ardia moved away from that site."],
  redirect: ["refused", "The site answered with a redirect, which Ardia doesn't follow for sign-in requests."],
  too_large: ["too_large", "The response is too large."],
  timeout: ["failed", "The site didn't answer in time."],
  network: ["failed", "The request didn't reach the site, or the site refused it."],
  status: ["failed", "The site didn't send the file."],
  gone: ["failed", "The download stopped."],
};

const answerError = (code: unknown, consent: ConsentToken | null): { code: ErrorCode; message: string } => {
  const [kind, text] = ERRORS[typeof code === "string" && Object.hasOwn(ERRORS, code) ? code : "network"]!;
  if (kind === "refused") notePlugin("plugin_site_refusals", consent);
  return { code: kind, message: text };
};

function refusedPlace(body: Body, consent: ConsentToken | null): Body {
  notePlugin("plugin_site_refusals", consent);
  return body;
}

type FetchAnswer = { error?: unknown; status?: unknown; headers?: unknown; body?: unknown };

async function siteFetch(t: SiteTransport, c: Caller, m: PluginManifest, params: Record<string, unknown>, consent: ConsentToken | null): Promise<Body> {
  const op = opOf(c);
  const target = siteTarget(m, params.url);
  if (typeof target === "string") return target.includes("isn't one of") ? refused(target, consent) : failure("bad_request", target);
  const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
  if (!METHODS.includes(method)) return failure("bad_request", `method is one of ${METHODS.join(", ")}.`);
  const headers = siteHeadersOf(params.headers, m.permissions.siteHeaders);
  if (typeof headers === "string") return failure("bad_request", headers);
  if (params.body !== undefined && typeof params.body !== "string") return failure("bad_request", "body is text; JSON.stringify an object first.");
  const body = params.body as string | undefined;
  if (body !== undefined && utf8Bytes(body) > SITES_LIMITS.bodyBytes) return failure("bad_request", `body is over ${SITES_LIMITS.bodyBytes / 1024} KB.`);
  if (body !== undefined && (method === "GET" || method === "HEAD")) return failure("bad_request", `A ${method} request has no body.`);
  const [least, most] = SITES_LIMITS.timeoutMs;
  const given = params.timeoutMs;
  if (given !== undefined && (typeof given !== "number" || !Number.isInteger(given) || given < least || given > most)) return failure("bad_request", `timeoutMs is a whole number from ${least} to ${most}.`);
  const timeoutMs = (given as number | undefined) ?? SITES_LIMITS.defaultTimeoutMs;
  const where = sessionPlace(c, params.session);
  if (isBody(where)) return refusedPlace(where, consent);
  if (!takeToken(c.name)) return failure("refused", "Too many sign-in requests at once; wait a moment.");
  const release = admit(c.name);
  try {
    const opened = await t.open(c.name, target.origin, where, () => stillAllowed(op, where));
    if (!opened.ok) return failure("failed", opened.reason);
    if (!stillAllowed(op, where)) return refused(ENDED, consent);
    notePlugin("plugin_site_fetches", consent);
    const spec = { origin: target.origin, url: target.url, method, headers, ...(body !== undefined ? { body } : {}), timeoutMs, cap: SITES_LIMITS.replyBodyBytes, keep: KEPT_RESPONSE_HEADERS };
    const answer = await t.run<FetchAnswer>(opened.key, FETCH_SCRIPT(spec), timeoutMs + 5000);
    if (!stillAllowed(op, where)) return refused(ENDED, consent);
    if (!isFields(answer)) {
      notePlugin("plugin_site_fetch_failures", consent);
      return failure("failed", t.alive(opened.key) ? "The site's page in Ardia didn't answer." : "The window the request ran in closed.");
    }
    if (answer.error !== undefined || typeof answer.status !== "number" || !Number.isInteger(answer.status) || answer.status < 100 || answer.status > 599 || typeof answer.body !== "string") {
      notePlugin("plugin_site_fetch_failures", consent);
      const error = answerError(answer.error, consent);
      return failure(error.code, error.message);
    }
    if (utf8Bytes(answer.body) > SITES_LIMITS.replyBodyBytes) return failure("too_large", "The response is too large.");
    return { result: { status: answer.status, ok: answer.status >= 200 && answer.status < 300, headers: cleanHeaders(answer.headers), body: answer.body } };
  } finally {
    release();
  }
}

type StartAnswer = { error?: unknown; status?: unknown; total?: unknown };
type ChunkAnswer = { error?: unknown; data?: unknown; size?: unknown; end?: unknown };

function settleState(d: Download, state: DownloadState) {
  d.last = state;
  if (state.state === "running") return;
  const kept = ended.get(d.caller.name) ?? new Map<string, DownloadState>();
  kept.set(d.id, state);
  while (kept.size > SITES_LIMITS.keptEnded) kept.delete(kept.keys().next().value!);
  ended.set(d.caller.name, kept);
}

function send(d: Download) {
  if (acceptsRun(d.caller.name, d.caller.run)) sendToPlugin(d.caller.name, d.caller.run, JSON.stringify({ event: "sites.download", time: Date.now(), data: d.last }));
}

const DOWNLOAD_OPERATION = "operation:";

const filesOp = (name: string, op: "stage" | "publish" | "discard", path: string, stage: string, data?: string, first = false) =>
  filesCall({ op, plugin: name, root: null, ticket: filesTicket(), path, stage, ...(op === "discard" ? {} : { operation: stage }), ...(data !== undefined ? { data } : {}), ...(first ? { first: true } : {}) }).catch((error: unknown) => ({
    ok: false as const,
    code: "unavailable" as const,
    message: String(error),
  }));

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

async function runDownload(t: SiteTransport, d: Download, target: SiteTarget, headers: Record<string, string>, maxBytes: number, where: SitePlace, consent: ConsentToken | null) {
  let received = 0;
  let staged = false;
  let total = 0;
  const finish = async (state: "done" | "failed" | "cancelled", extra: { code?: string; error?: string; size?: number } = {}) => {
    settleState(d, { download: d.id, state, received, ...(total ? { total } : {}), ...extra });
    if (state !== "done" && d.key && t.alive(d.key)) await t.run(d.key, DOWNLOAD_CANCEL(d.id), SITES_LIMITS.cancelWaitMs);
    if (state !== "done" && staged) await filesOp(d.caller.name, "discard", d.to, d.stage);
    if (state === "failed") notePlugin("plugin_site_download_failures", consent);
    if (state === "cancelled") notePlugin("plugin_site_download_cancels", consent);
    downloads.delete(d.id);
    send(d);
  };
  const fail = (code: string, message: string) => finish("failed", { code, error: message });
  const live = () => !d.cancelled && stillAllowed(d, where, true);
  const opened = await Promise.race([t.open(d.caller.name, target.origin, where, () => live()), d.halted.then(() => null)]);
  if (!opened || !live()) return finish("cancelled");
  if (!opened.ok) return fail("failed", opened.reason);
  d.key = opened.key;
  notePlugin("plugin_site_downloads", consent);
  const started = await t.run<StartAnswer>(opened.key, DOWNLOAD_START({ origin: target.origin, url: target.url, headers, id: d.id, timeoutMs: SITES_LIMITS.startWaitMs }), SITES_LIMITS.startWaitMs + 5000, d.halted);
  if (!live()) return finish("cancelled");
  if (!isFields(started)) return fail("failed", t.alive(opened.key) ? "The site's page in Ardia didn't answer." : "The window the download ran in closed.");
  if (started.error !== undefined) {
    const error = answerError(started.error, consent);
    return fail(error.code, typeof started.status === "number" ? `${error.message} (HTTP ${started.status})` : error.message);
  }
  total = typeof started.total === "number" && Number.isSafeInteger(started.total) && started.total > 0 ? started.total : 0;
  if (total > maxBytes) return fail("too_large", `The file is ${total} bytes, over the ${maxBytes} this download allows.`);
  settleState(d, { download: d.id, state: "running", received: 0, total });
  send(d);
  let lastSent = Date.now();
  for (;;) {
    if (!live()) return finish("cancelled");
    if (!t.alive(opened.key)) return fail("failed", "The window the download ran in closed.");
    const step = await t.run<ChunkAnswer>(opened.key, DOWNLOAD_NEXT(d.id, SITES_LIMITS.chunkBytes), SITES_LIMITS.chunkWaitMs, d.halted);
    if (!live()) return finish("cancelled");
    if (!isFields(step)) return fail("failed", t.alive(opened.key) ? "The site stopped sending the file." : "The window the download ran in closed.");
    if (step.error !== undefined || typeof step.data !== "string" || step.data.length % 4 !== 0 || !BASE64.test(step.data)) return fail("failed", "The download stopped before the end.");
    const bytes = decodedBytes(step.data);
    if (bytes > SITES_LIMITS.chunkBytes || step.size !== bytes) return fail("failed", "The site's page sent a part that doesn't match what it said.");
    received += bytes;
    if (received > maxBytes) return fail("too_large", `The file is over the ${maxBytes} bytes this download allows.`);
    if (bytes || !staged) {
      const first = !staged;
      staged = true;
      const outcome = await filesOp(d.caller.name, "stage", d.to, d.stage, step.data, first);
      if (!live()) return finish("cancelled");
      if (!isFields(outcome) || outcome.ok !== true) {
        const error = fileFailure(outcome);
        return fail(error.code, error.message);
      }
    }
    if (step.end === true) {
      if (!live() || !t.alive(opened.key)) return finish("cancelled");
      const published = await filesOp(d.caller.name, "publish", d.to, d.stage);
      if (!isFields(published) || published.ok !== true) {
        if (!live()) return finish("cancelled");
        const error = fileFailure(published);
        return fail(error.code, error.message);
      }
      staged = false;
      return finish("done", { size: received });
    }
    const now = Date.now();
    if (now - lastSent >= SITES_LIMITS.progressGapMs) {
      lastSent = now;
      settleState(d, { download: d.id, state: "running", received, total });
      send(d);
    }
  }
}

function siteDownload(t: SiteTransport, c: Caller, m: PluginManifest, params: Record<string, unknown>, consent: ConsentToken | null): Body {
  if (!m.permissions.files) return refused("sites.download needs the files permission too: the file lands in the plugin's data folder.", consent);
  const target = siteTarget(m, params.url);
  if (typeof target === "string") return target.includes("isn't one of") ? refused(target, consent) : failure("bad_request", target);
  const problem = pathProblem(params.to);
  if (problem) return failure("bad_path", `to: ${problem}`);
  const headers = siteHeadersOf(params.headers, m.permissions.siteHeaders);
  if (typeof headers === "string") return failure("bad_request", headers);
  const max = params.maxBytes ?? SITES_LIMITS.maxDownloadBytes;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1 || max > SITES_LIMITS.maxDownloadBytes) return failure("bad_request", `maxBytes is a whole number from 1 to ${SITES_LIMITS.maxDownloadBytes}, the plugin's whole file quota.`);
  if ([...downloads.values()].some((d) => d.caller.name === c.name)) return failure("refused", "This plugin is already downloading; wait for it or cancel it.");
  const where = sessionPlace(c, params.session);
  if (isBody(where)) return refusedPlace(where, consent);
  if (!takeToken(c.name)) return failure("refused", "Too many sign-in requests at once; wait a moment.");
  const release = admit(c.name);
  let halt = () => {};
  const halted = new Promise<void>((resolve) => (halt = resolve));
  const id = `d${secureRandomHex(10)}`;
  const d: Download = { ...opOf(c), id, to: params.to as string, stage: stageId(), cancelled: false, key: null, halt, halted, last: { download: id, state: "running", received: 0 } };
  downloads.set(d.id, d);
  void runDownload(t, d, target, headers, max, where, consent)
    .catch(() => {
      settleState(d, { download: d.id, state: "failed", received: d.last.received, code: "failed", error: "The download stopped." });
      downloads.delete(d.id);
      send(d);
    })
    .finally(release);
  return { result: { download: d.id } };
}

function cancelDownload(d: Download) {
  d.cancelled = true;
  filesRevoke(d.caller.name, `${DOWNLOAD_OPERATION}${d.stage}`);
  d.halt();
}

function siteCancel(c: Caller, params: Record<string, unknown>): Body {
  const d = typeof params.download === "string" ? downloads.get(params.download) : undefined;
  if (d && d.caller.name === c.name) cancelDownload(d);
  return { result: { ok: true } };
}

function siteStatus(c: Caller, params: Record<string, unknown>): Body {
  const id = params.download;
  if (typeof id !== "string") return failure("bad_request", "status needs a download's id.");
  const running = downloads.get(id);
  if (running && running.caller.name === c.name) return { result: running.last };
  const done = ended.get(c.name)?.get(id);
  return done ? { result: done } : failure("not_found", "There's no such download.");
}

function siteSession(c: Caller, consent: ConsentToken | null): Body {
  const where = currentPlace();
  if (isBody(where)) return refusedPlace(where, consent);
  for (const [id, s] of sessions) if (s.plugin === c.name && s.run !== c.run) sessions.delete(id);
  const mine = [...sessions].filter(([, s]) => s.plugin === c.name);
  while (mine.length >= SITES_LIMITS.sessions) sessions.delete(mine.shift()![0]);
  const id = `s${secureRandomHex(10)}`;
  sessions.set(id, { ...where, plugin: c.name, run: c.run });
  return { result: { session: id } };
}

export function sitesMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> {
  if (method === "sites.cancel") return siteCancel(c, params);
  if (method === "sites.status") return siteStatus(c, params);
  if (method === "sites.available") return { result: { available: !!transportFor(c.name) && m.permissions.sites.length > 0 && signInOn(c.name) } };
  const consent = consentToken();
  if (!m.permissions.sites.length) return refused("sites needs the sites permission.", consent);
  if (!signInOn(c.name)) return refused(SIGNED_OUT_OFF, consent);
  const t = transportFor(c.name);
  if (!t) return failure("unavailable", sitesTransportOn() ? NO_TRANSPORT : SITES_TRANSPORT_OFF_REASON);
  if (method === "sites.session") return siteSession(c, consent);
  return method === "sites.fetch" ? siteFetch(t, c, m, params, consent) : siteDownload(t, c, m, params, consent);
}

export function stopPluginSites(name: string) {
  invalidate(name);
  for (const d of downloads.values()) if (d.caller.name === name) cancelDownload(d);
  for (const [id, s] of sessions) if (s.plugin === name) sessions.delete(id);
  transport?.dropPlugin(name);
}

export function setPluginSignIn(name: string, on: boolean): boolean {
  const consent = consentToken();
  invalidate(name);
  const saved = updateRecord(
    name,
    (r) => {
      if (r === NO_RECORD) return null;
      const { sitesOff: _was, ...rest } = r;
      return on ? rest : { ...rest, sitesOff: true };
    },
    consent,
  );
  if (!on) stopPluginSites(name);
  else for (const d of [...downloads.values()]) if (d.caller.name === name) cancelDownload(d);
  if (saved && !on) notePlugin("plugin_site_signin_revokes", consent);
  return saved;
}

let listening = false;

export function startSiteChannels() {
  if (listening) return;
  listening = true;
  transport ??= hiddenPageTransport;
  onProcessStopped(stopPluginSites);
}
