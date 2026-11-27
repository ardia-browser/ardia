import type { PluginManifest } from "../../lib/pluginManifest";
import { pluginWebUrlWithin } from "../../lib/pluginWebUrl";
import { onSignInCallback, signInListen, signInStop } from "../../platform/plugins";
import { deleteHistoryUrls, queryHistoryUnfiltered, setHistoryFilter } from "../../platform/history";
import { failure } from "../automation/automationMethods";
import { eligibleKind, isEligiblePlace, isEligibleTab } from "../automation/automationWindows";
import type { Body } from "../automation/controlSocket";
import { activeTabId, engineProfile } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { notePlugin, type PluginCount } from "../telemetry/pluginCounts";
import { warnFor } from "../telemetry/consoleConsent";
import { acceptsRun, onProcessStopped } from "./process";
import { hideSignInTab, openingSignInTab, showSignInTab } from "./signInTabs";

export const SIGN_IN_METHODS = ["signIn.start"] as const;

export const SIGN_IN_LIMITS = { urlChars: 8192, callbackChars: 2048, redirectChars: 16384, defaultTimeoutMs: 15 * 60_000, minTimeoutMs: 1000, maxTimeoutMs: 15 * 60_000, nativeMarginMs: 5000 } as const;

export type SignInHost = "127.0.0.1" | "localhost" | "::1";

export type SignInCallback = { base: string; host: SignInHost; port: number; path: string };

type Caller = { name: string; run: number };

type Session = {
  id: string;
  plugin: string;
  run: number;
  callback: SignInCallback;
  state: string;
  consent: ConsentToken | null;
  settle: (body: Body) => void;
  tabId: string | null;
  engine: string | null;
  returnTo: string | null;
  caughtTarget: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  stopWatching: () => void;
  done: boolean;
};

const sessions = new Map<string, Session>();
const secretStates = new Map<string, number>();

const STATE_AFTERLIFE_MS = 60_000;
const HISTORY_SWEEP_URLS = 2000;

export const carriesSignInState = (text: string) => [...secretStates.keys()].some((state) => text.includes(state));

function keepStateSecret(state: string) {
  secretStates.set(state, (secretStates.get(state) ?? 0) + 1);
  setHistoryFilter({ hides: carriesSignInState, hidden: (profile, urls) => void deleteHistoryUrls(profile, urls).catch(() => {}) });
}

function releaseStateLater(state: string) {
  setTimeout(() => {
    const left = (secretStates.get(state) ?? 1) - 1;
    if (left > 0) secretStates.set(state, left);
    else secretStates.delete(state);
    if (!secretStates.size) setHistoryFilter(null);
  }, STATE_AFTERLIFE_MS);
}

async function sweepHistory(engine: string, state: string) {
  const urls = (await queryHistoryUnfiltered(engine, HISTORY_SWEEP_URLS, 1)).map((e) => e.url).filter((url) => url.includes(state));
  if (urls.length) await deleteHistoryUrls(engine, urls);
}

function forgetClosed(state: string) {
  const s = useBrowser.getState();
  const keep = <T>(list: T[]) => list.filter((entry) => !JSON.stringify(entry).includes(state));
  const closedTabs = keep(s.closedTabs);
  const closedWindows = keep(s.closedWindows);
  if (closedTabs.length !== s.closedTabs.length || closedWindows.length !== s.closedWindows.length) useBrowser.setState({ closedTabs, closedWindows });
}
let nextSession = 0;
let listening = false;

const CALLBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{3,4})(\/[A-Za-z0-9/_.~-]*)?$/;
const STATE = /^[A-Za-z0-9_-]{16,256}$/;
const REDIRECT_QUERY = /^\?[\x21-\x22\x24-\x7e]*$/;

const addressesOf = (host: SignInHost): string[] => (host === "localhost" ? ["127.0.0.1", "::1"] : [host]);

export function signInPathProblem(path: string): string | null {
  if (path === "/") return null;
  const parts = path.slice(1).split("/");
  return parts.some((part) => part === "" || part === "." || part === "..") ? "callback's path has an empty, . or .. part" : null;
}

export function signInCallbackOf(raw: unknown): SignInCallback | { problem: string } {
  if (typeof raw !== "string") return { problem: "callback isn't text" };
  if (raw.length > SIGN_IN_LIMITS.callbackChars) return { problem: `callback is over ${SIGN_IN_LIMITS.callbackChars} characters` };
  const found = CALLBACK.exec(raw);
  if (!found) return { problem: "callback is http://127.0.0.1:<port>/<path>, http://localhost:<port>/<path> or http://[::1]:<port>/<path>, with a path of letters, digits, / _ . ~ and -, and no user name, %, query or fragment" };
  const port = Number(found[2]);
  if (port < 1024 || port > 65535) return { problem: "callback's port is 1024 to 65535" };
  const path = found[3] ?? "/";
  const problem = signInPathProblem(path);
  if (problem) return { problem };
  const host = found[1] === "[::1]" ? "::1" : (found[1] as SignInHost);
  return { base: `http://${found[1]}:${port}`, host, port, path };
}

export function signInStateOf(raw: unknown): string | null {
  return typeof raw === "string" && STATE.test(raw) ? raw : null;
}

const decoded = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

export function queryState(query: string): string | null {
  let found: string | null = null;
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = decoded(eq < 0 ? pair : pair.slice(0, eq));
    if (name === null) return null;
    if (name !== "state") continue;
    const value = decoded(eq < 0 ? "" : pair.slice(eq + 1));
    if (found !== null || value === null) return null;
    found = value;
  }
  return found;
}

export function signInUrlOf(raw: unknown, state: string): { url: string } | { problem: string } {
  const checked = pluginWebUrlWithin(raw, SIGN_IN_LIMITS.urlChars);
  if ("problem" in checked) return { problem: `url ${checked.problem}` };
  if (!checked.url.startsWith("https://")) return { problem: "url is an https address" };
  const query = /^[^?#]*\?([^#]*)/.exec(checked.url)?.[1] ?? "";
  if (queryState(query) !== state) return { problem: "url has no state query parameter equal to state" };
  return { url: checked.url };
}

export function signInRedirect(callback: SignInCallback, state: string, target: unknown): string | null {
  if (typeof target !== "string" || target.length > SIGN_IN_LIMITS.redirectChars) return null;
  if (!target.startsWith(`${callback.path}?`)) return null;
  const query = target.slice(callback.path.length);
  if (!REDIRECT_QUERY.test(query) || queryState(query.slice(1)) !== state) return null;
  return `${callback.base}${target}`;
}

export function signInTimeoutOf(raw: unknown): number | null {
  if (raw === undefined) return SIGN_IN_LIMITS.defaultTimeoutMs;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < SIGN_IN_LIMITS.minTimeoutMs) return null;
  return Math.min(raw, SIGN_IN_LIMITS.maxTimeoutMs);
}

function frontmostNormalWindow(s: BrowserState): string | null {
  const normal = (id: string) => eligibleKind(s, id) === "normal";
  return s.ui.focusOrder.find(normal) ?? s.windowOrder.find(normal) ?? null;
}

function sharesEndpoint(a: SignInCallback, b: SignInCallback): boolean {
  return a.port === b.port && addressesOf(a.host).some((x) => addressesOf(b.host).includes(x));
}

function end(session: Session, body: Body, count: PluginCount, options: { closeTab?: boolean } = {}) {
  if (session.done) return;
  session.done = true;
  if (sessions.get(session.plugin) === session) sessions.delete(session.plugin);
  if (session.timer) clearTimeout(session.timer);
  session.stopWatching();
  signInStop(session.id);
  notePlugin(count, session.consent);
  if (session.tabId) {
    if (options.closeTab) leaveSignInTab(session, session.tabId);
    showSignInTab(session.tabId);
  }
  forgetClosed(session.state);
  if (session.engine !== null) void sweepHistory(session.engine, session.state).catch(() => {});
  releaseStateLater(session.state);
  session.settle(body);
}

function leaveSignInTab(session: Session, tabId: string) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab) return;
  const shown = activeTabId(s, tab.windowId) === tabId;
  const back = session.returnTo ? s.tabs[session.returnTo] : undefined;
  if (shown && back && back.windowId === tab.windowId && isEligibleTab(s, back.id)) s.activate(back.id);
  useBrowser.getState().closeTabs([tabId], { unrecorded: true });
}

function caught(session: Session, target: string) {
  if (session.done) return;
  const url = signInRedirect(session.callback, session.state, target);
  if (!url) return;
  if (!session.tabId) {
    session.caughtTarget = target;
    return;
  }
  if (!acceptsRun(session.plugin, session.run)) return end(session, failure("cancelled", "The plugin stopped during sign-in."), "plugin_sign_in_cancelled");
  end(session, { result: { url } }, "plugin_sign_in_completed", { closeTab: true });
}

function watchTab(session: Session, tabId: string): () => void {
  return useBrowser.subscribeTo(["tabs", "windows", "peeks"], (s) => {
    if (session.done) return;
    if (!s.tabs[tabId]) return end(session, failure("cancelled", "You closed the sign-in tab."), "plugin_sign_in_cancelled");
    if (!isEligiblePlace(s, tabId)) end(session, failure("cancelled", "The sign-in tab moved where plugins can't follow."), "plugin_sign_in_cancelled");
  });
}

function listen() {
  if (listening) return;
  listening = true;
  onProcessStopped((name) => {
    const session = sessions.get(name);
    if (session) end(session, failure("cancelled", "The plugin stopped during sign-in."), "plugin_sign_in_cancelled");
  });
  onSignInCallback((e) => {
    const session = [...sessions.values()].find((x) => x.id === e.id);
    if (session) caught(session, e.target);
  });
}

function refuse(message: string, consent: ConsentToken | null): Body {
  notePlugin("plugin_sign_in_refused", consent);
  return failure("refused", message);
}

function portInUse(message: string, consent: ConsentToken | null): Body {
  notePlugin("plugin_sign_in_port_in_use", consent);
  return failure("port_in_use", message);
}

function openTab(session: Session, url: string): Body | null {
  const now = useBrowser.getState();
  const into = frontmostNormalWindow(now);
  if (!into) return failure("no_window", "No normal window to sign in from.");
  session.returnTo = activeTabId(now, into) ?? null;
  session.engine = engineProfile(now, now.windows[into]!.profileId);
  const tabId = openingSignInTab(Object.keys(now.tabs), () => {
    const id = now.newTab(into, { url, profileId: now.windows[into]!.profileId, gated: true });
    if (id && useBrowser.getState().tabs[id]) hideSignInTab(id);
    return id;
  });
  if (!tabId || !useBrowser.getState().tabs[tabId]) return failure("failed", "The sign-in tab didn't open.");
  session.tabId = tabId;
  return null;
}

export function signInMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> {
  if (method !== "signIn.start") return failure("bad_request", `${method} isn't a sign-in method.`);
  const consent = consentToken();
  if (!m.permissions.signIn) return refuse("signIn.start needs the signIn permission.", consent);
  const state = signInStateOf(params.state);
  if (!state) return refuse("state is 16 to 256 letters, digits, _ and -.", consent);
  const url = signInUrlOf(params.url, state);
  if ("problem" in url) return refuse(`${url.problem}.`, consent);
  const callback = signInCallbackOf(params.callback);
  if ("problem" in callback) return refuse(`${callback.problem}.`, consent);
  const timeoutMs = signInTimeoutOf(params.timeoutMs);
  if (timeoutMs === null) return failure("bad_request", `timeoutMs is a whole number of milliseconds, at least ${SIGN_IN_LIMITS.minTimeoutMs}.`);
  if (!acceptsRun(c.name, c.run)) return failure("refused", "This run of the plugin has ended.");
  if (!frontmostNormalWindow(useBrowser.getState())) return failure("no_window", "No normal window to sign in from.");
  listen();
  const previous = sessions.get(c.name);
  if (previous) end(previous, failure("cancelled", "Another sign-in from this plugin replaced it."), "plugin_sign_in_cancelled", { closeTab: true });
  const clash = [...sessions.values()].find((other) => sharesEndpoint(other.callback, callback));
  if (clash) return portInUse(`Another plugin is already waiting for a sign-in on port ${callback.port}.`, consent);
  return new Promise<Body>((settle) => {
    const session: Session = { id: `s${++nextSession}`, plugin: c.name, run: c.run, callback, state, consent, settle, tabId: null, engine: null, returnTo: null, caughtTarget: null, timer: null, stopWatching: () => {}, done: false };
    sessions.set(c.name, session);
    keepStateSecret(state);
    void signInListen(session.id, callback.host, callback.port, callback.path, state, timeoutMs + SIGN_IN_LIMITS.nativeMarginMs).then(
      (bound) => arm(session, bound, url.url, timeoutMs),
      (error) => arm(session, { ok: false, code: "failed", reason: String(error) }, url.url, timeoutMs),
    );
  });
}

function arm(session: Session, bound: Awaited<ReturnType<typeof signInListen>>, url: string, timeoutMs: number) {
  if (session.done) return;
  if (!bound.ok) {
    if (bound.code === "port_in_use") {
      session.done = true;
      sessions.delete(session.plugin);
      releaseStateLater(session.state);
      return session.settle(portInUse(`Port ${session.callback.port} is taken by another program, so the sign-in can't be caught there. Pick another port.`, session.consent));
    }
    warnFor(session.consent, `[plugins] ${session.plugin}'s sign-in couldn't listen: ${bound.reason}`);
    return end(session, failure("failed", "Ardia couldn't listen for the sign-in."), "plugin_sign_in_cancelled");
  }
  if (!acceptsRun(session.plugin, session.run)) return end(session, failure("cancelled", "The plugin stopped during sign-in."), "plugin_sign_in_cancelled");
  const opened = openTab(session, url);
  if (opened) return end(session, opened, "plugin_sign_in_cancelled");
  notePlugin("plugin_sign_in_started", session.consent);
  session.timer = setTimeout(() => end(session, failure("timeout", "The sign-in didn't finish in time."), "plugin_sign_in_timeouts"), timeoutMs);
  session.stopWatching = watchTab(session, session.tabId!);
  if (session.caughtTarget) caught(session, session.caughtTarget);
}

export const signInSessionCount = () => sessions.size;
