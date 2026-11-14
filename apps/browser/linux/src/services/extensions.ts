import { app, BrowserWindow, dialog, nativeImage, net, webContents as allContents, type Session, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineModule } from "../bridge";
import { defineDomain, emitDomainEvent } from "../engine/domains";
import { allGuests, onGuestAttached, windowOf, type Guest } from "../engine/guests";
import { isBackground } from "../paths";
import { downloadStoreExtension, unpackCrxFile } from "./crx";
import { ElectronChromeExtensions, installChromeWebStore } from "./vendorModules";
import { database, pref, setPref } from "./database";
import { onProfileSession } from "./guests";
import { extensionsModulePath, webStoreModulePath } from "./vendorPreloads";
import { engineError, isPrivateProfile, profileDirectory, sessionFor } from "./profiles";
import { guardExtensionWorkers, withGuardedExtensionChannels } from "./extensionSenders";

type Entry = { path: string; enabled: boolean; pinned: boolean; incognito: boolean; fileAccess: boolean; location: "webstore" | "unpacked" | "crx"; installed: number };
type Manifest = Record<string, unknown> & {
  name?: string;
  short_name?: string;
  version?: string;
  description?: string;
  manifest_version?: number;
  icons?: Record<string, string>;
  permissions?: unknown[];
  optional_permissions?: unknown[];
  host_permissions?: unknown[];
  options_page?: string;
  options_ui?: { page?: string };
  action?: ActionManifest;
  browser_action?: ActionManifest;
  side_panel?: { default_path?: string };
  homepage_url?: string;
  update_url?: string;
  default_locale?: string;
};
type ActionManifest = { default_popup?: string; default_title?: string; default_icon?: string | Record<string, string> };
type ActionDetails = { title?: string; popup?: string; text?: string; color?: string | number[]; icon?: { path?: string | Record<string, string>; imageData?: unknown }; enabled?: boolean; tabs: Record<string, Omit<ActionDetails, "tabs">> };

const REGISTRY_PREF = "extensions.registry";
const WEB_STORE = "https://chromewebstore.google.com/detail/";
const ADOPT_WAIT_MS = 5000;
const UPDATE_SERVICE = "https://update.googleapis.com/service/update2/json";
const UPDATE_REPLY_PREFIX = ")]}'\n";
const FIRST_UPDATE_CHECK_MS = 60_000;
const UPDATE_CHECK_EVERY_MS = 5 * 60 * 60 * 1000;

const contexts = new Map<string, { session: Session; chrome: ElectronChromeExtensions }>();
const pendingPrompts = new Map<string, (accepted: boolean) => void>();
const watchingActions = new Set<string>();

const registryOf = (profile: string): Record<string, Entry> => pref(database(profile), REGISTRY_PREF, {});
const saveRegistry = (profile: string, registry: Record<string, Entry>) => setPref(database(profile), REGISTRY_PREF, registry);
const extensionsFolder = (profile: string) => join(profileDirectory(profile), "Extensions");

function changed(profile: string, id: string, event: "installed" | "uninstalled" | "enabled" | "disabled" | "configured" | "reloaded") {
  emitDomainEvent("extensions.changed", { profile, id, event });
}

function readManifest(path: string): Manifest {
  try {
    return JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as Manifest;
  } catch {
    throw engineError("the folder has no readable manifest.json");
  }
}

function localized(path: string, manifest: Manifest, text: string | undefined): string {
  const match = /^__MSG_(\w+)__$/.exec(text ?? "");
  if (!match) return text ?? "";
  const locales = [app.getLocale().replace("-", "_"), app.getLocale().split("-")[0]!, manifest.default_locale ?? "en", "en"];
  for (const locale of locales) {
    try {
      const messages = JSON.parse(readFileSync(join(path, "_locales", locale, "messages.json"), "utf8")) as Record<string, { message?: string }>;
      const key = Object.keys(messages).find((name) => name.toLowerCase() === match[1]!.toLowerCase());
      if (key && messages[key]?.message) return messages[key]!.message!;
    } catch {}
  }
  return text ?? "";
}

function largestIcon(icons: string | Record<string, string> | undefined, wanted = 128): string | null {
  if (!icons) return null;
  if (typeof icons === "string") return icons;
  const sizes = Object.keys(icons).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const size = sizes.find((candidate) => candidate >= wanted) ?? sizes.at(-1);
  return size === undefined ? null : (icons[String(size)] ?? null);
}

function iconUri(path: string, relative: string | null): string {
  if (!relative) return "";
  const file = resolve(path, relative.replace(/^\//, ""));
  if (!file.startsWith(resolve(path))) return "";
  const image = nativeImage.createFromPath(file);
  return image.isEmpty() ? "" : image.toDataURL();
}

const strings = (list: unknown[] | undefined) => (list ?? []).filter((item): item is string => typeof item === "string");
const actionOf = (manifest: Manifest) => manifest.action ?? manifest.browser_action;

function describe(profile: string, id: string, entry: Entry, chrome: Session | null) {
  const loaded = chrome?.extensions.getExtension(id);
  const path = loaded?.path ?? entry.path;
  let manifest: Manifest;
  try {
    manifest = (loaded?.manifest as Manifest | undefined) ?? readManifest(path);
  } catch {
    manifest = { name: id, version: "" };
  }
  const action = actionOf(manifest);
  const options = manifest.options_ui?.page ?? manifest.options_page;
  const hosts = strings(manifest.host_permissions);
  const permissions = strings(manifest.permissions);
  return {
    id,
    name: localized(path, manifest, manifest.name) || id,
    version: manifest.version ?? "",
    description: localized(path, manifest, manifest.description),
    enabled: entry.enabled && !!loaded,
    state: entry.enabled ? (loaded ? "ENABLED" : "TERMINATED") : "DISABLED",
    icon: iconUri(path, largestIcon(manifest.icons)),
    permissions: [...permissions, ...hosts],
    siteAccess: null,
    sites: hosts,
    optionsUrl: options ? `chrome-extension://${id}/${options.replace(/^\//, "")}` : null,
    pinned: entry.pinned,
    incognito: false,
    fileAccess: entry.fileAccess,
    mayModify: true,
    errors: entry.enabled && !loaded && !isPrivateProfile(profile) ? ["The extension didn't load"] : [],
    location: entry.location === "unpacked" ? "UNPACKED" : "INTERNAL",
    path: entry.location === "unpacked" ? entry.path : null,
    fromWebStore: entry.location === "webstore",
    webStoreUrl: entry.location === "webstore" ? `${WEB_STORE}${id}` : null,
    homepageUrl: manifest.homepage_url ?? (entry.location === "webstore" ? `${WEB_STORE}${id}` : null),
    hasAction: !!action,
    popup: action?.default_popup ?? null,
    actionTitle: action?.default_title ? localized(path, manifest, action.default_title) : null,
    actionIcon: iconUri(path, largestIcon(action?.default_icon, 32) ?? largestIcon(manifest.icons, 32)) || null,
    sidePanel: manifest.side_panel?.default_path ?? null,
  };
}

async function load(session: Session, entry: Entry) {
  return session.extensions.loadExtension(entry.path, { allowFileAccess: entry.fileAccess });
}

function unload(session: Session, id: string) {
  if (session.extensions.getExtension(id)) session.extensions.removeExtension(id);
}

const browserActions = (chrome: ElectronChromeExtensions) =>
  (chrome as unknown as { api: { browserAction: { actionMap: Map<string, ActionDetails>; getPopupUrl(id: string, tabId: number): string | undefined; onUpdate(): void } } }).api.browserAction;

const routerOf = (chrome: ElectronChromeExtensions) => (chrome as unknown as { ctx: { router: { sendEvent(id: string, event: string, ...args: unknown[]): void }; store: { tabDetailsCache: Map<number, unknown> } } }).ctx;

function colorText(color: string | number[] | undefined): string | null {
  if (!color) return null;
  if (typeof color === "string") return color;
  const [r = 0, g = 0, b = 0, a = 255] = color;
  return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`;
}

function actionIcon(session: Session, id: string, icon: ActionDetails["icon"]): string {
  const extension = session.extensions.getExtension(id);
  if (!extension) return "";
  if (icon?.imageData && typeof icon.imageData === "object") {
    const sizes = icon.imageData as Record<string, string>;
    const best = largestIcon(sizes, 32);
    if (best?.startsWith("data:")) return best;
  }
  if (typeof icon?.imageData === "string") return icon.imageData;
  const path = typeof icon?.path === "string" ? icon.path : largestIcon(icon?.path, 32);
  if (path) return iconUri(extension.path, path);
  const manifest = extension.manifest as Manifest;
  return iconUri(extension.path, largestIcon(actionOf(manifest)?.default_icon, 32) ?? largestIcon(manifest.icons, 32));
}

export function actionStates(profile: string, webContentsId: number | null, ids: string[]) {
  const context = contexts.get(profile);
  if (!context) return {};
  const actions = browserActions(context.chrome);
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const action = actions.actionMap.get(id);
    if (!action) continue;
    const tab = webContentsId === null ? {} : (action.tabs[String(webContentsId)] ?? {});
    const merged = { ...action, ...tab };
    out[id] = {
      badgeText: merged.text ?? "",
      badgeColor: colorText(merged.color),
      badgeTextColor: null,
      title: merged.title ?? "",
      popup: (webContentsId === null ? undefined : actions.getPopupUrl(id, webContentsId)) ?? (merged.popup ? new URL(merged.popup, `chrome-extension://${id}/`).href : ""),
      enabled: merged.enabled !== false,
      icon: actionIcon(context.session, id, tab.icon ?? action.icon),
    };
  }
  return out;
}

type SearchProvider = { name?: string; keyword?: string; search_url?: string; suggest_url?: string; is_default?: boolean };

export function extensionSearchEngines(profile: string) {
  const context = isPrivateProfile(profile) ? undefined : contextFor(profile);
  if (!context) return [];
  return context.session.extensions.getAllExtensions().flatMap((extension) => {
    const manifest = extension.manifest as Manifest & { chrome_settings_overrides?: { search_provider?: SearchProvider } };
    const provider = manifest.chrome_settings_overrides?.search_provider;
    if (!provider?.search_url) return [];
    const placeholder = (url: string) => url.replace("{searchTerms}", "%s");
    return [
      {
        name: localized(extension.path, manifest, provider.name) || extension.name,
        keyword: localized(extension.path, manifest, provider.keyword),
        url: placeholder(provider.search_url),
        suggestionsUrl: provider.suggest_url ? placeholder(provider.suggest_url) : "",
        default: provider.is_default === true,
        isOmniboxExtension: false,
        extension: { id: extension.id, name: extension.name },
      },
    ];
  });
}

export function executeAction(contents: WebContents, extensionId: string): "popup" | "sidePanel" | "none" | null {
  const entry = [...contexts.entries()].find(([, context]) => context.session === contents.session);
  if (!entry) return null;
  const [, context] = entry;
  const extension = context.session.extensions.getExtension(extensionId);
  if (!extension) return null;
  const actions = browserActions(context.chrome);
  if (actions.getPopupUrl(extensionId, contents.id)) return "popup";
  const manifest = extension.manifest as Manifest;
  if (manifest.side_panel?.default_path && !actionOf(manifest)) return "sidePanel";
  const ctx = routerOf(context.chrome);
  ctx.router.sendEvent(extensionId, "browserAction.onClicked", ctx.store.tabDetailsCache.get(contents.id));
  return "none";
}

function askToInstall(profile: string, details: { id: string; localizedName: string; manifest: Manifest; icon: Electron.NativeImage }): Promise<boolean> {
  const requestId = randomUUID();
  const permissions = [...strings(details.manifest.permissions), ...strings(details.manifest.host_permissions)];
  return new Promise<boolean>((resolvePrompt) => {
    pendingPrompts.set(requestId, resolvePrompt);
    emitDomainEvent("extensions.installPrompt", {
      requestId,
      profile,
      id: details.id,
      name: details.localizedName,
      version: details.manifest.version ?? "",
      type: "install",
      icon: details.icon.isEmpty() ? "" : details.icon.toDataURL(),
      permissions,
      tabId: null,
    });
  });
}

function remember(profile: string, id: string, entry: Entry) {
  const registry = registryOf(profile);
  const fresh = !registry[id];
  registry[id] = { ...registry[id], ...entry };
  saveRegistry(profile, registry);
  if (fresh) changed(profile, id, "installed");
}

const pendingAdopts = new Map<Session, ((tab: [WebContents, BrowserWindow]) => void)[]>();

function setUp(session: Session, profile: string) {
  if (isPrivateProfile(profile) || contexts.has(profile)) return;
  guardExtensionWorkers(session);
  const chrome = withGuardedExtensionChannels(() => new ElectronChromeExtensions({
    license: "GPL-3.0",
    session,
    modulePath: extensionsModulePath(),
    createTab: (details) =>
      new Promise((resolveTab, reject) => {
        const adoptId = randomUUID();
        const waiting = pendingAdopts.get(session) ?? [];
        const settle = (tab: [WebContents, BrowserWindow]) => {
          clearTimeout(timer);
          resolveTab(tab);
        };
        waiting.push(settle);
        pendingAdopts.set(session, waiting);
        const timer = setTimeout(() => {
          const list = pendingAdopts.get(session) ?? [];
          pendingAdopts.set(session, list.filter((entry) => entry !== settle));
          reject(new Error("the tab didn't open"));
        }, ADOPT_WAIT_MS);
        emitDomainEvent("extensions.tabs", { action: "adopt", adoptId, url: details.url ?? "about:blank", profile });
      }),
    selectTab: () => {},
    removeTab: (tab) => {
      if (!tab.isDestroyed()) tab.close();
    },
  } as ConstructorParameters<typeof ElectronChromeExtensions>[0]));
  contexts.set(profile, { session, chrome });
  const actions = browserActions(chrome);
  const update = actions.onUpdate.bind(actions);
  actions.onUpdate = () => {
    update();
    if (watchingActions.has(profile)) emitDomainEvent("extensions.action", { profile, id: "", kind: "action" });
  };
  session.extensions.on("extension-loaded", (_event, extension) => {
    if (registryOf(profile)[extension.id]) return;
    const folder = extensionsFolder(profile);
    remember(profile, extension.id, {
      path: extension.path,
      enabled: true,
      pinned: false,
      incognito: false,
      fileAccess: false,
      location: extension.path.startsWith(folder) ? "webstore" : "unpacked",
      installed: Date.now(),
    });
  });
  void installChromeWebStore({
    session,
    modulePath: webStoreModulePath(),
    extensionsPath: extensionsFolder(profile),
    loadExtensions: false,
    autoUpdate: false,
    allowUnpackedExtensions: false,
    beforeInstall: async (details) => {
      if (!(await askToInstall(profile, details as never))) return { action: "deny" };
      await downloadStoreExtension(details.id, extensionsFolder(profile));
      return { action: "allow" };
    },
  }).catch((error: unknown) => console.warn("[ardia extensions] the Chrome Web Store didn't set up", error));
  for (const [id, entry] of Object.entries(registryOf(profile))) {
    if (!entry.enabled) continue;
    if (!existsSync(join(entry.path, "manifest.json"))) {
      console.warn(`[ardia extensions] ${id} is missing from ${entry.path}`);
      continue;
    }
    load(session, entry).catch((error: unknown) => console.warn(`[ardia extensions] ${id} didn't load`, error));
  }
  const check = () => void updateWebStoreExtensions(profile).catch((error: unknown) => console.warn("[ardia extensions] the update check failed", error));
  setTimeout(check, FIRST_UPDATE_CHECK_MS);
  setInterval(check, UPDATE_CHECK_EVERY_MS);
}

function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return difference > 0;
  }
  return false;
}

async function storeVersions(ids: string[]): Promise<Map<string, string>> {
  const chrome = process.versions.chrome ?? "";
  const response = await net.fetch(UPDATE_SERVICE, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Goog-Update-Interactivity": "bg", "X-Goog-Update-AppId": ids.join(","), "X-Goog-Update-Updater": `chromiumcrx-${chrome}` },
    body: JSON.stringify({
      request: {
        "@updater": "chromiumcrx",
        acceptformat: "crx3",
        app: ids.map((appid) => ({ appid, updatecheck: {} })),
        os: { platform: "linux", arch: process.arch },
        prodversion: chrome,
        protocol: "3.1",
        requestid: randomUUID(),
        sessionid: randomUUID(),
      },
    }),
  });
  const reply = await response.text();
  if (!response.ok || !reply.startsWith(UPDATE_REPLY_PREFIX)) throw new Error(`the update service answered ${response.status}`);
  type App = { appid?: string; updatecheck?: { status?: string; manifest?: { version?: string } } };
  const apps = (JSON.parse(reply.slice(UPDATE_REPLY_PREFIX.length)) as { response?: { app?: App[] } }).response?.app ?? [];
  const versions = new Map<string, string>();
  for (const found of apps) if (found.appid && found.updatecheck?.status === "ok" && found.updatecheck.manifest?.version) versions.set(found.appid, found.updatecheck.manifest.version);
  return versions;
}

const updatingProfiles = new Set<string>();

export async function updateWebStoreExtensions(profile: string): Promise<{ id: string; from: string; to: string }[]> {
  if (isPrivateProfile(profile) || updatingProfiles.has(profile)) return [];
  updatingProfiles.add(profile);
  try {
    const installed = new Map<string, string>();
    for (const [id, entry] of Object.entries(registryOf(profile))) {
      if (entry.location !== "webstore") continue;
      try {
        installed.set(id, readManifest(entry.path).version ?? "");
      } catch {}
    }
    if (!installed.size) return [];
    const available = await storeVersions([...installed.keys()]);
    const updated: { id: string; from: string; to: string }[] = [];
    for (const [id, current] of installed) {
      const latest = available.get(id);
      if (!latest || !isNewer(latest, current)) continue;
      const folder = extensionsFolder(profile);
      const path = await downloadStoreExtension(id, folder);
      const registry = registryOf(profile);
      const entry = registry[id];
      if (!entry) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      const previous = entry.path;
      entry.path = path;
      saveRegistry(profile, registry);
      const { session } = contextFor(profile);
      if (entry.enabled) {
        unload(session, id);
        await load(session, entry);
      }
      if (previous !== path && resolve(previous).startsWith(`${resolve(folder)}/`)) await rm(previous, { recursive: true, force: true });
      changed(profile, id, "reloaded");
      updated.push({ id, from: current, to: readManifest(path).version ?? latest });
    }
    return updated;
  } finally {
    updatingProfiles.delete(profile);
  }
}

function contextFor(profile: string) {
  if (isPrivateProfile(profile)) throw engineError("extensions don't run in private windows yet");
  if (!contexts.has(profile)) setUp(sessionFor(profile), profile);
  return contexts.get(profile)!;
}

onProfileSession((session, profile) => setUp(session, profile));

function trackTab(guest: Guest) {
  const { contents } = guest;
  const context = [...contexts.values()].find((entry) => entry.session === contents.session);
  const window = windowOf(guest);
  if (!context || !window || tracked.has(contents)) return;
  tracked.add(contents);
  context.chrome.addTab(contents, window);
  const adopt = pendingAdopts.get(contents.session)?.shift();
  if (adopt) adopt([contents, window]);
  contents.on("focus", () => {
    if (!contents.isDestroyed()) context.chrome.selectTab(contents);
  });
  contents.once("destroyed", () => {
    try {
      context.chrome.removeTab(contents);
    } catch {}
  });
}

const tracked = new WeakSet<WebContents>();

onGuestAttached(trackTab);

const guestOfTab = (tabId: unknown) => (typeof tabId === "string" && tabId ? allGuests().find((guest) => guest.tabId === tabId) : undefined);

function inspect(path: string) {
  const manifest = readManifest(path);
  const action = actionOf(manifest);
  const options = manifest.options_ui?.page ?? manifest.options_page;
  return {
    name: localized(path, manifest, manifest.name),
    shortName: manifest.short_name ? localized(path, manifest, manifest.short_name) : null,
    version: manifest.version ?? "",
    description: localized(path, manifest, manifest.description),
    manifestVersion: manifest.manifest_version ?? 2,
    icon: iconUri(path, largestIcon(manifest.icons)) || null,
    permissions: strings(manifest.permissions),
    optionalPermissions: strings(manifest.optional_permissions),
    hostPermissions: strings(manifest.host_permissions),
    hasAction: !!action,
    popup: action?.default_popup ?? null,
    optionsPage: options ?? null,
    sidePanel: manifest.side_panel?.default_path ?? null,
    path,
  };
}

async function installFrom(profile: string, path: string, location: Entry["location"]) {
  const { session } = contextFor(profile);
  const known = registryOf(profile);
  const extension = await session.extensions.loadExtension(path, { allowFileAccess: false });
  const previous = known[extension.id];
  remember(profile, extension.id, {
    path,
    enabled: true,
    pinned: previous?.pinned ?? false,
    incognito: previous?.incognito ?? false,
    fileAccess: previous?.fileAccess ?? false,
    location,
    installed: previous?.installed ?? Date.now(),
  });
  if (previous) changed(profile, extension.id, "reloaded");
  return { id: extension.id };
}

function entryOf(profile: string, id: string) {
  const entry = registryOf(profile)[id];
  if (!entry) throw engineError(`no extension ${id}`);
  return entry;
}

const idArg = (args: Record<string, unknown>) => {
  if (typeof args.id !== "string" || !args.id) throw engineError("id is missing");
  return args.id;
};

defineDomain("extensions", {
  list: (_args, profile) => {
    if (isPrivateProfile(profile)) return { extensions: [] };
    const { session } = contextFor(profile);
    return { extensions: Object.entries(registryOf(profile)).map(([id, entry]) => describe(profile, id, entry, session)) };
  },
  inspectUnpacked: (args) => inspect(typeof args.path === "string" ? args.path : ""),
  install: (args, profile) => installFrom(profile, typeof args.path === "string" ? args.path : "", "unpacked"),
  installCrx: async (args, profile) => {
    const { id, path } = await unpackCrxFile(typeof args.path === "string" ? args.path : "", extensionsFolder(profile));
    await installFrom(profile, path, "crx");
    return { id };
  },
  setEnabled: async (args, profile) => {
    const id = idArg(args);
    const { session } = contextFor(profile);
    const registry = registryOf(profile);
    const entry = registry[id] ?? entryOf(profile, id);
    entry.enabled = args.enabled === true;
    saveRegistry(profile, registry);
    if (entry.enabled) await load(session, entry);
    else unload(session, id);
    changed(profile, id, entry.enabled ? "enabled" : "disabled");
    return { ok: true };
  },
  uninstall: async (args, profile) => {
    const id = idArg(args);
    const { session } = contextFor(profile);
    const registry = registryOf(profile);
    const entry = registry[id];
    unload(session, id);
    delete registry[id];
    saveRegistry(profile, registry);
    if (entry && entry.location !== "unpacked") await rm(join(extensionsFolder(profile), id), { recursive: true, force: true });
    changed(profile, id, "uninstalled");
    return { ok: true };
  },
  reload: async (args, profile) => {
    const id = idArg(args);
    const { session } = contextFor(profile);
    const entry = entryOf(profile, id);
    unload(session, id);
    if (entry.enabled) await load(session, entry);
    changed(profile, id, "reloaded");
    return { ok: true };
  },
  configure: async (args, profile) => {
    const id = idArg(args);
    const { session } = contextFor(profile);
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const registry = registryOf(profile);
    const entry = registry[id] ?? entryOf(profile, id);
    if (typeof options.pinned === "boolean") entry.pinned = options.pinned;
    if (options.incognito === true) throw engineError("extensions can't run in private windows on Linux: Electron loads them only into sessions kept on disk");
    if (typeof options.siteAccess === "string" && options.siteAccess !== "allSites") throw engineError("extensions run on every site they ask for on Linux; site access can't be narrowed yet");
    const fileAccessChanged = typeof options.fileAccess === "boolean" && options.fileAccess !== entry.fileAccess;
    if (typeof options.fileAccess === "boolean") entry.fileAccess = options.fileAccess;
    saveRegistry(profile, registry);
    if (fileAccessChanged && entry.enabled) {
      unload(session, id);
      await load(session, entry);
    }
    changed(profile, id, "configured");
    return { ok: true };
  },
  chooseFolder: async () => {
    if (isBackground()) {
      console.info("[ardia dialogs] folder panel for an unpacked extension");
      return null;
    }
    const owner = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = { properties: ["openDirectory"], message: "Choose an extension folder" };
    const { canceled, filePaths } = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return canceled ? null : (filePaths[0] ?? null);
  },
  resolveInstallPrompt: (args) => {
    const requestId = typeof args.requestId === "string" ? args.requestId : "";
    const resolvePrompt = pendingPrompts.get(requestId);
    pendingPrompts.delete(requestId);
    resolvePrompt?.(args.accepted === true);
    return null;
  },
  actionStates: (args, profile) => {
    const guest = guestOfTab(args.tabId);
    return actionStates(guest?.profile ?? profile, guest?.contents.id ?? null, Array.isArray(args.ids) ? strings(args.ids) : []);
  },
  sidePanelUrl: (args, profile) => {
    const extensionId = typeof args.extensionId === "string" ? args.extensionId : "";
    const extension = contexts.get(guestOfTab(args.tabId)?.profile ?? profile)?.session.extensions.getExtension(extensionId);
    const path = (extension?.manifest as Manifest | undefined)?.side_panel?.default_path;
    return path ? `chrome-extension://${extensionId}/${path.replace(/^\//, "")}` : null;
  },
  watchActions: (_args, profile) => {
    watchingActions.add(profile);
    if (!isPrivateProfile(profile)) contextFor(profile);
    return null;
  },
  syncState: () => ({ ready: false, extensions: [], pending: [], settling: [], queued: [], intents: [] }),
  syncApply: () => ({ state: "pending" }),
  loadHealth: (_args, profile) => {
    if (isPrivateProfile(profile)) return { dropped: 0, enabled: 0, disabled: {} };
    const { session } = contextFor(profile);
    const entries = Object.entries(registryOf(profile));
    const loaded = entries.filter(([id, entry]) => entry.enabled && session.extensions.getExtension(id)).length;
    const off = entries.filter(([, entry]) => !entry.enabled).length;
    return { dropped: entries.filter(([, entry]) => entry.enabled).length - loaded, enabled: loaded, disabled: off ? { user: off } : {} };
  },
});

defineModule("ArdiaLinuxExtensions", {
  async: {
    executeAction: (webContentsId: number, extensionId: string) => {
      const contents = allContents.fromId(webContentsId);
      return contents ? executeAction(contents, extensionId) : null;
    },
    actionStates: (profile: string, webContentsId: number | null, ids: string[]) => actionStates(profile, webContentsId, ids),
    checkForUpdates: (profile: string) => updateWebStoreExtensions(profile ?? ""),
    installFromWebStore: async (profile: string, id: string) => {
      const { session } = contextFor(profile);
      const extension = session.extensions.getExtension(id) ?? (await session.extensions.loadExtension(await downloadStoreExtension(id, extensionsFolder(profile))));
      return { id: extension.id, name: extension.name, version: extension.version };
    },
  },
});
