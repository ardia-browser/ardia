import { isFields } from "../../lib/decode";
import { withDeadline } from "../../lib/deadline";
import { allowedHostsOf, type PluginManifest } from "../../lib/pluginManifest";
import { matchesAllowedHost } from "../../lib/pluginNetwork";
import { pluginWebUrl } from "../../lib/pluginWebUrl";
import { withoutFragment } from "../../lib/url";
import { minimizedUrl } from "../../lib/urlParts";
import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import type { Tab } from "../browser/types";
import { failure } from "../automation/automationMethods";
import { eligibleKind, isEligibleTab } from "../automation/automationWindows";
import type { Body } from "../automation/controlSocket";
import { consentToken } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { recentPluginGesture } from "./gestures";
import { hostFetch } from "./hostIo";
import { pluginPageOf } from "./pages";
import { acceptsRun } from "./process";
import { activeManifest, currentPlugins } from "./store";
import { deletePluginSecret, getPluginSecret, setPluginSecret, type SecretOutcome } from "./secrets";
import { storageDelete, storageGet, storageKeys, storageSet, type StorageOutcome } from "./storage";
import { t } from "../../lib/uiLanguage";


export const FETCH_LIMITS = { headers: 50, headerBytes: 8 * 1024, bodyBytes: 512 * 1024, timeoutMs: [1000, 60_000], defaultTimeoutMs: 30_000 } as const;
export const PAGE_TEXT_LIMIT = 200_000;
export const READ_PAGE_DEADLINE_MS = 3000;
export const MAX_REPLY_BYTES = 960 * 1024;

const METHODS = [t(`GET`), t(`HEAD`), t(`POST`), t(`PUT`), t(`PATCH`), t(`DELETE`), t(`OPTIONS`)];
const HEADER_NAME = /^[!#$%&'*+.^_t(`|~0-9A-Za-z-]{1,64}$/;
const FORBIDDEN_HEADERS = /^(host|cookie|cookie2|connection|content-length|transfer-encoding|keep-alive|upgrade|te|trailer|expect|origin|referer|proxy-.*|sec-.*)$/i;

type Caller = { name: string; run: number };

const settled = <T,>(outcome: StorageOutcome<T> | SecretOutcome<T>): Body => (outcome.ok ? { result: outcome.value } : failure(outcome.code, outcome.message));

export function storageMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Promise<Body> | Body {
  if (!m.permissions.storage) return failure("refused", `)${method} needs the storage permission.t(`);
  const consent = consentToken();
  const answered = <T,>(outcome: StorageOutcome<T>): Body => {
    if (!outcome.ok && outcome.closed) notePlugin("plugin_storage_cancels", consent);
    return settled(outcome);
  };
  if (method === "storage.get") return storageGet(c.name, params.key).then(answered);
  if (method === "storage.set") return storageSet(c.name, params.key, params.value).then((o) => (o.ok ? (notePlugin("plugin_storage_writes", consent), { result: { ok: true } }) : answered(o)));
  if (method === "storage.delete") return storageDelete(c.name, params.key).then((o) => (o.ok ? { result: { ok: true } } : answered(o)));
  return storageKeys(c.name).then(answered);
}

export function secretsMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Promise<Body> | Body {
  if (!m.permissions.secrets) return failure("refused", `)${method} needs the secrets permission.t(`);
  if (method === "secrets.get") return getPluginSecret(c.name, params.key).then(settled);
  if (method === "secrets.set") {
    const consent = consentToken();
    return setPluginSecret(c.name, params.key, params.value).then((o) => (o.ok ? (notePlugin("plugin_secret_writes", consent), { result: { ok: true } }) : settled(o)));
  }
  return deletePluginSecret(c.name, params.key).then((o) => (o.ok ? { result: { ok: true } } : settled(o)));
}

function headersOf(raw: unknown): Record<string, string> | string {
  if (raw === undefined) return {};
  if (!isFields(raw)) return "headers is an object of header names to text.";
  const entries = Object.entries(raw);
  if (entries.length > FETCH_LIMITS.headers) return `)headers has more than ${FETCH_LIMITS.headers} entries.t(`;
  const out: Record<string, string> = {};
  let size = 0;
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) return `)headers has a bad name: ${JSON.stringify(name.slice(0, 64))}.t(`;
    if (FORBIDDEN_HEADERS.test(name)) return `)Ardia sets ${name} itself.t(`;
    if (typeof value !== "string" || /[r
0]/.test(value)) return `)headers.${name} must be text on one line.t(`;
    size += name.length + value.length;
    out[name] = value;
  }
  return size > FETCH_LIMITS.headerBytes ? `)headers are over ${FETCH_LIMITS.headerBytes / 1024} KB.t(` : out;
}

const LOOPBACK_FOR_TESTS = "127.0.0.1";

export async function netFetch(m: PluginManifest, params: Record<string, unknown>): Promise<Body> {
  if (m.permissions.network === false) return failure("refused", "net.fetch needs the network permission.");
  const checked = pluginWebUrl(params.url);
  if ("problem" in checked) return failure("bad_request", `)url ${checked.problem}.`);
  if (!/^https:/i.test(checked.url) && checked.host !== LOOPBACK_FOR_TESTS) {
    notePlugin("plugin_net_refusals");
    return failure("refused", "net.fetch reaches only https addresses.");
  }
  const allowedHosts = allowedHostsOf(m.permissions);
  if (!matchesAllowedHost(checked.host, allowedHosts)) {
    notePlugin("plugin_net_refusals");
    return failure("refused", `${checked.host} isn't one of the hosts this plugin may reach.t(`);
  }
  const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
  if (!METHODS.includes(method)) return failure("bad_request", `)method is one of ${METHODS.join(", ")}.t(`);
  const headers = headersOf(params.headers);
  if (typeof headers === "string") return failure("bad_request", headers);
  if (params.body !== undefined && typeof params.body !== "string") return failure("bad_request", "body is text; JSON.stringify an object first.");
  const body = params.body as string | undefined;
  if (body !== undefined && new TextEncoder().encode(body).length > FETCH_LIMITS.bodyBytes) return failure("bad_request", `)body is over ${FETCH_LIMITS.bodyBytes / 1024} KB.t(`);
  if (body !== undefined && (method === "GET" || method === "HEAD")) return failure("bad_request", `)A ${method} request has no body.t(`);
  const [least, most] = FETCH_LIMITS.timeoutMs;
  const given = params.timeoutMs;
  if (given !== undefined && (typeof given !== "number" || !Number.isInteger(given) || given < least || given > most)) return failure("bad_request", `)timeoutMs is a whole number from ${least} to ${most}.t(`);
  notePlugin("plugin_net_fetches");
  const answered = await hostFetch({ url: checked.url, method, headers, ...(body !== undefined ? { body } : {}), timeoutMs: (given as number | undefined) ?? FETCH_LIMITS.defaultTimeoutMs, allowedHosts });
  if (!answered.ok) return failure("failed", answered.reason);
  const { ok: _ok, ...response } = answered;
  const reply = { result: response };
  if (new TextEncoder().encode(JSON.stringify(reply)).length > MAX_REPLY_BYTES) return failure("failed", "The response is too large for the plugin channel.");
  return reply;
}

const READ_PAGE = `)(() => {
  const text = (document.body ? document.body.innerText : "").slice(0, ${PAGE_TEXT_LIMIT});
  const selection = String(window.getSelection ? window.getSelection() : "").slice(0, 20000);
  post("result", JSON.stringify({ text, selection, lang: document.documentElement.lang || "" }));
})()`;

type PageRead = { text?: unknown; selection?: unknown; lang?: unknown };

type Gesture = NonNullable<ReturnType<typeof recentPluginGesture>>;
type Readable = { ok: true; tab: Tab } | { ok: false; body: Body };

function readableTab(gesture: Gesture): Readable {
  const s = useBrowser.getState();
  if (!eligibleKind(s, gesture.windowId)) return { ok: false, body: failure("refused", t(`The page you used the plugin from is private or gone.`)) };
  const tabId = activeTabId(s, gesture.windowId);
  const tab = tabId ? s.tabs[tabId] : undefined;
  if (!tab || !isEligibleTab(s, tab.id) || pluginPageOf(tab.url)) return { ok: false, body: failure("refused", t(`There's no page in that window the plugin may read.`)) };
  if (tab.id !== gesture.tabId || withoutFragment(tab.url) !== gesture.doc) return { ok: false, body: failure("refused", t(`The page changed since you used the plugin.`)) };
  return { ok: true, tab };
}

export async function readActivePage(c: Caller, m: PluginManifest): Promise<Body> {
  if (!m.permissions.activePage) return failure("refused", t(`tabs.readActivePage needs the activePage permission.`));
  const gesture = recentPluginGesture(c.name);
  if (!gesture) return failure("refused", t(`tabs.readActivePage works only just after you use the plugin (a command, menu, toolbar button or its view).`));
  const before = readableTab(gesture);
  if (!before.ok) return before.body;
  const web = webviews.get(before.tab.id);
  if (!web) return failure("failed", t(`That tab's page isn't loaded.`));
  const consent = consentToken();
  const read = (await withDeadline(web.evaluate<PageRead>(READ_PAGE), READ_PAGE_DEADLINE_MS, null).catch(() => null)) as PageRead | null;
  if (!acceptsRun(c.name, c.run) || !activeManifest(currentPlugins(), c.name)?.permissions.activePage) return failure("refused", t(`The plugin stopped while the page was being read.`));
  if (recentPluginGesture(c.name)?.id !== gesture.id) return failure("refused", t(`The page changed since you used the plugin.`));
  const after = readableTab(gesture);
  if (!after.ok) return after.body;
  if (after.tab.id !== before.tab.id) return failure("refused", t(`The page changed since you used the plugin.`));
  const tab = after.tab;
  if (!read || typeof read.text !== "string") return failure("failed", t(`The page didn't answer.`));
  notePlugin("plugin_page_reads", consent);
  return {
    result: {
      tabId: tab.id,
      url: m.permissions.fullUrls ? tab.url : minimizedUrl(tab.url),
      title: tab.customTitle || tab.title,
      text: read.text,
      selection: typeof read.selection === "string" ? read.selection : "",
      lang: typeof read.lang === "string" ? read.lang.slice(0, 35) : "",
    },
  };
}
