import { FiltersEngine, Request } from "@ghostery/adblocker";
import { app, ipcMain, net } from "electron";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDomain } from "tldts-experimental";
import { defineDomain, emitDomainEvent } from "../engine/domains";
import { acceptsPage } from "../ipcSenders";
import { dataDirectory } from "../paths";
import { definePageScript } from "./guests";
import { onBeforeRequest, onHeadersReceived } from "./requests";

type Category = "ads" | "trackers" | "cookies" | "regional" | "annoyances" | "security";
type ListSource = { id: string; title: string; category: Category; defaultOn: boolean; files: string[] };
type Saved = { enabled: boolean; lists: Record<string, boolean>; allowedHosts: string[]; filters: Record<string, number> };

const ASSETS = "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets";
const ENGINE_VERSION = "2.20.3";
const REFRESH_AFTER_MS = 4 * 86_400_000;
const FETCH_TIMEOUT_MS = 30_000;

const LISTS: ListSource[] = [
  {
    id: "ublock-filters",
    title: "uBlock filters – Ads",
    category: "ads",
    defaultOn: true,
    files: ["ublock-origin/filters.txt", "ublock-origin/filters-2020.txt", "ublock-origin/filters-2021.txt", "ublock-origin/filters-2022.txt", "ublock-origin/filters-2023.txt", "ublock-origin/filters-2024.txt"],
  },
  { id: "ublock-badware", title: "uBlock filters – Badware risks", category: "security", defaultOn: true, files: ["ublock-origin/badware.txt"] },
  { id: "ublock-privacy", title: "uBlock filters – Privacy", category: "trackers", defaultOn: true, files: ["ublock-origin/privacy.txt"] },
  { id: "ublock-quick-fixes", title: "uBlock filters – Quick fixes", category: "ads", defaultOn: true, files: ["ublock-origin/quick-fixes.txt"] },
  { id: "ublock-unbreak", title: "uBlock filters – Unbreak", category: "ads", defaultOn: true, files: ["ublock-origin/unbreak.txt"] },
  { id: "ublock-abuse", title: "uBlock filters – Resource abuse", category: "security", defaultOn: true, files: ["ublock-origin/resource-abuse.txt"] },
  { id: "easylist", title: "EasyList", category: "ads", defaultOn: true, files: ["easylist/easylist.txt"] },
  { id: "easyprivacy", title: "EasyPrivacy", category: "trackers", defaultOn: true, files: ["easylist/easyprivacy.txt"] },
  { id: "plowe-0", title: "Peter Lowe's Ad and tracking server list", category: "ads", defaultOn: true, files: ["peter-lowe/serverlist.txt"] },
  { id: "fanboy-cookiemonster", title: "EasyList – Cookie notices", category: "cookies", defaultOn: false, files: ["easylist/easylist-cookie.txt"] },
  { id: "ublock-cookies", title: "uBlock filters – Cookie notices", category: "cookies", defaultOn: false, files: ["ublock-origin/annoyances-cookies.txt"] },
  { id: "ublock-annoyances", title: "uBlock filters – Annoyances", category: "annoyances", defaultOn: false, files: ["ublock-origin/annoyances-others.txt"] },
];

const folder = () => join(dataDirectory(), "ContentBlocker");
const fileOf = (asset: string) => join(folder(), "lists", asset.replace(/\//g, "_"));
const stateFile = () => join(folder(), "state.json");
const engineFile = () => join(folder(), "engine.bin");
const engineKeyFile = () => join(folder(), "engine.key");

function readSaved(): Saved {
  const fallback: Saved = { enabled: true, lists: {}, allowedHosts: [], filters: {} };
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<Saved>) };
  } catch {
    return fallback;
  }
}

let saved = readSaved();
let engine: FiltersEngine | null = null;
let building: Promise<void> | null = null;
let rebuildAgain = false;
let lastError: string | undefined;
let parseMs = 0;
let networkFilters = 0;
let cosmeticFilters = 0;
let lookups = 0;
let lookupMicros = 0;
let maxLookupMicros = 0;
let failNextMessage = false;
let delayNextLoadMs = 0;

const blockedListeners = new Set<(webContentsId: number, url: string) => void>();

export function onContentBlocked(listener: (webContentsId: number, url: string) => void): () => void {
  blockedListeners.add(listener);
  return () => void blockedListeners.delete(listener);
}

function save() {
  mkdirSync(folder(), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(saved));
}

const listOn = (list: ListSource) => saved.lists[list.id] ?? list.defaultOn;
const enabledLists = () => LISTS.filter(listOn);

const stats = () => ({
  ready: !!engine,
  enabled: saved.enabled,
  ...(engine ? { networkFilters, cosmeticFilters } : {}),
  parseMs,
  lookups,
  averageLookupMicros: lookups ? Math.round(lookupMicros / lookups) : 0,
  maxLookupMicros: Math.round(maxLookupMicros),
  ...(lastError ? { error: lastError } : {}),
});

const changed = () => emitDomainEvent("contentBlocker.changed", stats());

async function download(asset: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await net.fetch(`${ASSETS}/${asset}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`${asset}: HTTP ${response.status}`);
    const text = await response.text();
    mkdirSync(join(folder(), "lists"), { recursive: true });
    writeFileSync(fileOf(asset), text);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function assetText(asset: string, refresh: boolean): Promise<string> {
  if (!refresh) {
    try {
      return readFileSync(fileOf(asset), "utf8");
    } catch {}
  }
  return download(asset);
}

const age = (asset: string) => {
  try {
    return Date.now() - statSync(fileOf(asset)).mtimeMs;
  } catch {
    return Infinity;
  }
};

const countFilters = (text: string) => text.split("\n").filter((line) => line.trim() && !/^\s*[!#[]/.test(line) && !line.startsWith("#!")).length;

const engineKey = (lists: ListSource[]) =>
  JSON.stringify({ version: ENGINE_VERSION, lists: lists.map((list) => list.id), stamps: [...lists.flatMap((list) => list.files), "ublock-origin/resources.json"].map((asset) => Math.floor(age(asset) === Infinity ? 0 : statSync(fileOf(asset)).mtimeMs)) });

function loadCachedEngine(key: string): FiltersEngine | null {
  try {
    if (readFileSync(engineKeyFile(), "utf8") !== key) return null;
    return FiltersEngine.deserialize(readFileSync(engineFile()));
  } catch {
    return null;
  }
}

function measure(next: FiltersEngine) {
  const filters = next.getFilters();
  networkFilters = filters.networkFilters.length;
  cosmeticFilters = filters.cosmeticFilters.length;
}

async function build(refresh: boolean) {
  const lists = enabledLists();
  const assets = [...lists.flatMap((list) => list.files), "ublock-origin/resources.json"];
  const texts = new Map<string, string>();
  const failures: string[] = [];
  await Promise.all(
    assets.map(async (asset) => {
      try {
        texts.set(asset, await assetText(asset, refresh));
      } catch (error) {
        try {
          texts.set(asset, readFileSync(fileOf(asset), "utf8"));
        } catch {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }),
  );
  for (const list of lists) saved.filters[list.id] = list.files.reduce((sum, asset) => sum + countFilters(texts.get(asset) ?? ""), 0);
  save();
  const key = engineKey(lists);
  const started = performance.now();
  let next = refresh ? null : loadCachedEngine(key);
  if (!next) {
    next = FiltersEngine.parse(lists.flatMap((list) => list.files.map((asset) => texts.get(asset) ?? "")).join("\n"), {
      loadCosmeticFilters: true,
      loadNetworkFilters: true,
      loadCSPFilters: true,
      enableCompression: true,
      enableHtmlFiltering: false,
      enableMutationObserver: true,
      guessRequestTypeFromUrl: false,
    });
    const resources = texts.get("ublock-origin/resources.json");
    if (resources) next.updateResources(resources, `${resources.length}`);
    mkdirSync(folder(), { recursive: true });
    writeFileSync(engineFile(), next.serialize());
    writeFileSync(engineKeyFile(), key);
  }
  parseMs = Math.round(performance.now() - started);
  measure(next);
  engine = next;
  lastError = failures.length && !networkFilters ? failures.join("; ") : undefined;
}

function rebuild(refresh = false): Promise<void> {
  if (building) {
    rebuildAgain = true;
    return building;
  }
  building = (async () => {
    try {
      if (delayNextLoadMs) {
        const wait = delayNextLoadMs;
        delayNextLoadMs = 0;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      do {
        rebuildAgain = false;
        await build(refresh);
        refresh = false;
      } while (rebuildAgain);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn("[ardia content blocker] couldn't build the filters", error);
    } finally {
      building = null;
      changed();
    }
  })();
  return building;
}

function refreshStaleLists() {
  const stale = enabledLists().some((list) => list.files.some((asset) => age(asset) > REFRESH_AFTER_MS));
  if (stale) void rebuild(true);
}

const hostAllowed = (host: string) => saved.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));

function pageHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function blocking(details: { webContents?: Electron.WebContents }): boolean {
  if (!saved.enabled || !engine) return false;
  const page = details.webContents?.getURL();
  return !page || !hostAllowed(pageHost(page));
}

function requestOf(details: Electron.OnBeforeRequestListenerDetails | Electron.OnHeadersReceivedListenerDetails) {
  const page = details.webContents?.getURL() ?? "";
  return Request.fromRawDetails({
    requestId: `${details.id}`,
    tabId: details.webContentsId ?? -1,
    url: details.url,
    sourceUrl: details.frame?.url || details.referrer || page,
    type: (details.resourceType || "other") as Parameters<typeof Request.fromRawDetails>[0]["type"],
  });
}

onBeforeRequest((details) => {
  if (details.resourceType === "mainFrame" || !blocking(details)) return null;
  const started = performance.now();
  const { redirect, match } = engine!.match(requestOf(details));
  const micros = (performance.now() - started) * 1000;
  lookups++;
  lookupMicros += micros;
  maxLookupMicros = Math.max(maxLookupMicros, micros);
  if (!redirect && !match) return null;
  if (details.webContentsId !== undefined) for (const listener of blockedListeners) listener(details.webContentsId, details.url);
  return redirect ? { redirectURL: redirect.dataUrl } : { cancel: true };
});

onHeadersReceived((details) => {
  if ((details.resourceType !== "mainFrame" && details.resourceType !== "subFrame") || !blocking(details)) return null;
  const directives = engine!.getCSPDirectives(requestOf(details));
  if (directives === undefined) return null;
  const headers = { ...details.responseHeaders };
  const policies = directives.split(";").map((policy) => policy.trim());
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-security-policy") continue;
    policies.push(...values);
    delete headers[name];
  }
  headers["content-security-policy"] = [policies.join(";")];
  return { responseHeaders: headers };
});

function cosmeticsPage(ipc: Electron.IpcRenderer) {
  const CHANNEL = "ardia:cosmetics";
  const classes = new Set<string>();
  const ids = new Set<string>();
  const hrefs = new Set<string>();
  const collect = (root: Element | Document) => {
    const found = { classes: [] as string[], ids: [] as string[], hrefs: [] as string[] };
    const elements = root instanceof Element ? [root, ...Array.from(root.querySelectorAll("[class],[id],a[href]"))] : Array.from(root.querySelectorAll("[class],[id],a[href]"));
    for (const el of elements) {
      for (const name of Array.from(el.classList)) if (!classes.has(name)) classes.add(name), found.classes.push(name);
      if (el.id && !ids.has(el.id)) ids.add(el.id), found.ids.push(el.id);
      const href = el instanceof HTMLAnchorElement ? el.href : "";
      if (href && !hrefs.has(href)) hrefs.add(href), found.hrefs.push(href);
    }
    return found;
  };
  const send = (found: { classes: string[]; ids: string[]; hrefs: string[] }) => {
    if (found.classes.length || found.ids.length || found.hrefs.length) void ipc.invoke(CHANNEL, location.href, { ...found, lifecycle: "dom-update" });
  };
  void ipc.invoke(CHANNEL, location.href);
  const pending: Element[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const merged = { classes: [] as string[], ids: [] as string[], hrefs: [] as string[] };
    for (const el of pending.splice(0)) {
      const found = collect(el);
      merged.classes.push(...found.classes);
      merged.ids.push(...found.ids);
      merged.hrefs.push(...found.hrefs);
    }
    send(merged);
  };
  const start = () => {
    send(collect(document));
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.target instanceof Element) pending.push(mutation.target);
        for (const node of Array.from(mutation.addedNodes)) if (node instanceof Element) pending.push(node);
      }
      timer ??= setTimeout(flush, 50);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id", "href"] });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

definePageScript("ardia-cosmetics", cosmeticsPage);

type CosmeticsUpdate = { classes?: string[]; ids?: string[]; hrefs?: string[]; lifecycle?: string };

ipcMain.handle("ardia:cosmetics", (event, url: unknown, update: CosmeticsUpdate | undefined) => {
  if (!acceptsPage(event, "ardia:cosmetics")) return;
  if (typeof url !== "string" || !saved.enabled || !engine || hostAllowed(pageHost(url))) return;
  const parsed = parseDomain(url);
  const first = update === undefined;
  const { active, styles, scripts } = engine.getCosmeticsFilters({
    url,
    hostname: parsed.hostname || "",
    domain: parsed.domain || "",
    classes: update?.classes,
    hrefs: update?.hrefs,
    ids: update?.ids,
    getBaseRules: first,
    getInjectionRules: first,
    getExtendedRules: false,
    getRulesFromHostname: first,
    getRulesFromDOM: !first,
    callerContext: { frameId: event.frameId, processId: event.processId, lifecycle: update?.lifecycle },
  });
  if (active === false) return;
  if (styles.length) void event.sender.insertCSS(styles, { cssOrigin: "user" });
  for (const script of scripts) void event.sender.executeJavaScript(script, true).catch(() => {});
});

function state() {
  if (failNextMessage) {
    failNextMessage = false;
    throw Object.assign(new Error("the content blocker didn't answer"), { code: "ERR_ENGINE" });
  }
  return {
    enabled: saved.enabled,
    version: `ghostery-${ENGINE_VERSION}`,
    lists: LISTS.map((list) => ({ id: list.id, title: list.title, category: list.category, enabled: listOn(list), defaultOn: list.defaultOn, filters: saved.filters[list.id] ?? 0 })),
    allowedHosts: [...saved.allowedHosts].sort(),
    stats: stats(),
  };
}

defineDomain("contentBlocker", {
  state: () => state(),
  setEnabled: (args) => {
    saved.enabled = args.enabled === true;
    save();
    if (saved.enabled && !engine) void rebuild();
    changed();
    return null;
  },
  setListEnabled: (args) => {
    const list = LISTS.find((entry) => entry.id === args.id);
    if (!list) throw Object.assign(new Error("unknown list"), { code: "ERR_ENGINE" });
    saved.lists[list.id] = args.enabled === true;
    save();
    void rebuild();
    return null;
  },
  isAllowed: (args) => typeof args.host === "string" && hostAllowed(args.host.toLowerCase()),
  setAllowed: (args) => {
    const host = typeof args.host === "string" ? args.host.toLowerCase().replace(/^www\./, "") : "";
    if (!host) return null;
    saved.allowedHosts = saved.allowedHosts.filter((allowed) => allowed !== host);
    if (args.allowed === true) saved.allowedHosts.push(host);
    save();
    changed();
    return null;
  },
  devFailNextMessage: () => {
    failNextMessage = true;
    return null;
  },
  devDelayNextLoad: (args) => {
    delayNextLoadMs = typeof args.ms === "number" ? Math.max(0, args.ms) : 0;
    return null;
  },
});

void app.whenReady().then(() => {
  if (!saved.enabled) return;
  void rebuild().then(refreshStaleLists);
});
