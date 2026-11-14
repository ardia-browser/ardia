import { app, desktopCapturer, webContents as allContents, type Session, type WebContents } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "../paths";
import { defineDomain, emitDomainEvent } from "./domains";
import { provideLocation } from "./geolocation";
import { guestOf, tell, type Guest } from "./guests";
import { isPrivateProfile } from "./partitions";
import { onPageSession } from "./sessions";
import { rememberSiteSetting, siteSetting, SITE_SETTING_DEFAULTS, type SiteSettingType } from "../services/sites";
import { defineModule } from "../bridge";

type Decision = "allow" | "block";
type Stored = {
  externalApps: Record<string, { origin: string; scheme: string; app: string | null }[]>;
};
type Pending = { id: string; profile: string; origin: string; kinds: string[]; contents: WebContents; answer: (granted: boolean) => void };
type PendingExternal = { id: string; profile: string; origin: string; scheme: string; url: string; contents: WebContents; answer: (granted: boolean) => void };
type PendingDisplay = { id: string; guest: Guest; sources: Map<string, Electron.DesktopCapturerSource>; answer: (streams: Electron.Streams) => void };

const FILE = "external-apps.json";
const ALWAYS_ALLOWED = new Set(["fullscreen", "clipboard-sanitized-write", "mediaKeySystem", "speaker-selection"]);

const pending = new Map<string, Pending>();
const pendingExternal = new Map<string, PendingExternal>();
const pendingDisplay = new Map<string, PendingDisplay>();
let nextId = 0;

const storePath = () => join(dataDirectory(), "Engine", FILE);

function readStore(): Stored {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf8")) as Partial<Stored>;
    return { externalApps: parsed.externalApps ?? {} };
  } catch {
    return { externalApps: {} };
  }
}

function writeStore(store: Stored) {
  mkdirSync(join(dataDirectory(), "Engine"), { recursive: true });
  writeFileSync(storePath(), JSON.stringify(store, null, 2));
}

const asSiteSetting = (kind: string): SiteSettingType | null => (Object.hasOwn(SITE_SETTING_DEFAULTS, kind) ? (kind as SiteSettingType) : null);

function decided(profile: string, origin: string, kind: string): Decision | undefined {
  const type = asSiteSetting(kind);
  if (!type) return undefined;
  const value = siteSetting(profile, origin, type);
  return value === "ask" ? undefined : value;
}

function remember(profile: string, origin: string, kinds: string[], decision: Decision) {
  for (const kind of kinds) {
    const type = asSiteSetting(kind);
    if (type) rememberSiteSetting(profile, origin, type, decision);
  }
}

const originOf = (url: string) => {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
};

function kindsOf(permission: string, details: Electron.PermissionRequest | Electron.MediaAccessPermissionRequest | Record<string, unknown>): string[] {
  switch (permission) {
    case "media": {
      const types = ((details as Electron.MediaAccessPermissionRequest).mediaTypes ?? []) as string[];
      const kinds = [...(types.includes("video") ? ["camera"] : []), ...(types.includes("audio") ? ["microphone"] : [])];
      return kinds.length ? kinds : ["camera", "microphone"];
    }
    case "geolocation":
      return ["location"];
    case "notifications":
      return ["notifications"];
    case "midi":
    case "midiSysex":
      return ["midi"];
    case "clipboard-read":
      return ["clipboard"];
    case "pointerLock":
      return ["pointerLock"];
    case "keyboardLock":
      return ["keyboardLock"];
    case "idle-detection":
      return ["idleDetection"];
    case "storage-access":
    case "top-level-storage-access":
      return ["storageAccess"];
    case "window-management":
      return ["windowManagement"];
    case "fileSystem":
      return ["fileSystem"];
    case "display-capture":
      return ["screen"];
    default:
      return [];
  }
}

function withLocation(contents: WebContents, answer: (granted: boolean) => void): (granted: boolean) => void {
  return (granted) => {
    if (!granted) return answer(false);
    void provideLocation(contents)
      .catch(() => {})
      .finally(() => answer(true));
  };
}

function dismissFor(contents: WebContents) {
  for (const request of [...pending.values()]) {
    if (request.contents !== contents) continue;
    pending.delete(request.id);
    request.answer(false);
    emitDomainEvent("permissions.dismissed", { id: request.id });
  }
}

const externalLaunches = { opened: 0, refused: 0, automatic: 0 };

function takeExternalLaunches() {
  const taken = { ...externalLaunches };
  externalLaunches.opened = 0;
  externalLaunches.refused = 0;
  externalLaunches.automatic = 0;
  return taken;
}

function askExternal(contents: WebContents, profile: string, url: string, requestingUrl: string, answer: (granted: boolean) => void) {
  const guest = guestOf(contents);
  const scheme = url.slice(0, Math.max(0, url.indexOf(":"))).toLowerCase();
  const origin = originOf(requestingUrl) || originOf(guest?.url ?? "");
  const appName = app.getApplicationNameForProtocol(url) || null;
  const allowed = readStore().externalApps[profile]?.some((entry) => entry.origin === origin && entry.scheme === scheme);
  if (allowed) {
    externalLaunches.automatic++;
    return answer(true);
  }
  if (!guest) return answer(false);
  const id = `external-${++nextId}`;
  pendingExternal.set(id, { id, profile, origin, scheme, url, contents, answer });
  tell(guest, "externalApp", {
    id,
    url,
    scheme,
    origin: origin || null,
    app: appName,
    appPath: null,
    icon: null,
    title: appName ? `Open ${appName}?` : `Open this ${scheme}: link?`,
    message: origin ? `${new URL(origin).host} wants to open ${appName ?? "an app"}.` : null,
    remember: origin ? `Always allow ${new URL(origin).host} to open links of this type` : null,
  });
}

function handleRequest(session: Session, profile: string) {
  session.setPermissionRequestHandler((contents, permission, decide, details) => {
    const answer = permission === "geolocation" ? withLocation(contents, decide) : decide;
    if (ALWAYS_ALLOWED.has(permission)) return answer(true);
    if (permission === "openExternal") {
      const external = details as Electron.OpenExternalPermissionRequest;
      return askExternal(contents, profile, external.externalURL ?? "", external.requestingUrl ?? "", answer);
    }
    const kinds = kindsOf(permission, details);
    if (!kinds.length) return answer(false);
    const origin = originOf(details.requestingUrl ?? contents.getURL());
    if (!origin) return answer(false);
    const decisions = kinds.map((kind) => decided(profile, origin, kind));
    if (decisions.every((decision) => decision === "allow")) return answer(true);
    if (decisions.some((decision) => decision === "block")) return answer(false);
    const guest = guestOf(contents);
    const id = `permission-${++nextId}`;
    pending.set(id, { id, profile, origin, kinds, contents, answer });
    emitDomainEvent("permissions.requested", { id, tabId: guest?.tabId || null, origin, permissions: kinds });
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (ALWAYS_ALLOWED.has(permission)) return true;
    const origin = originOf(requestingOrigin) || originOf((details as { securityOrigin?: string }).securityOrigin ?? "");
    const kinds = kindsOf(permission, details as unknown as Record<string, unknown>);
    return !!origin && kinds.length > 0 && kinds.every((kind) => decided(profile, origin, kind) === "allow");
  });
  session.setDisplayMediaRequestHandler((request, answer) => {
    const contents = request.frame ? allContents.fromFrame(request.frame) : undefined;
    const guest = guestOf(contents);
    if (!guest) return answer({});
    void desktopCapturer
      .getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const id = `display-${++nextId}`;
        pendingDisplay.set(id, { id, guest, sources: new Map(sources.map((source) => [source.id, source])), answer });
        tell(guest, "displayMediaRequest", {
          id,
          origin: originOf(request.securityOrigin ?? guest.url),
          audio: request.audioRequested ? { tab: false, screen: true, window: null } : null,
          sources: sources.map((source) => ({ id: source.id, kind: source.id.startsWith("screen") ? "screen" : "window", name: source.name, width: 0, height: 0 })),
        });
      })
      .catch(() => answer({}));
  });
}

export function resolveDisplayMedia(id: string, sourceId: string | null, audio: boolean) {
  const request = pendingDisplay.get(id);
  if (!request) return;
  pendingDisplay.delete(id);
  const source = sourceId ? request.sources.get(sourceId) : undefined;
  if (!source) return request.answer({});
  request.answer(audio ? { video: source, audio: "loopback" } : { video: source });
}

onPageSession(handleRequest);

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) dismissFor(contents);
  });
  contents.once("destroyed", () => dismissFor(contents));
});

defineDomain("permissions", {
  resolve: (args) => {
    const request = pending.get(typeof args.id === "string" ? args.id : "");
    if (!request) return null;
    pending.delete(request.id);
    const granted = args.result === "accept";
    if (args.remember === true && args.result !== "dismiss") remember(request.profile, request.origin, request.kinds, granted ? "allow" : "block");
    request.answer(granted);
    return null;
  },
  resolveExternalApp: (args) => {
    const request = pendingExternal.get(typeof args.id === "string" ? args.id : "");
    if (!request) return null;
    pendingExternal.delete(request.id);
    const open = args.open === true;
    if (open && args.remember === true && request.origin && !isPrivateProfile(request.profile)) {
      const store = readStore();
      const list = (store.externalApps[request.profile] ??= []);
      if (!list.some((entry) => entry.origin === request.origin && entry.scheme === request.scheme))
        list.push({ origin: request.origin, scheme: request.scheme, app: app.getApplicationNameForProtocol(request.url) || null });
      writeStore(store);
    }
    if (open && request.contents.isDestroyed()) externalLaunches.refused++;
    else if (open) externalLaunches.opened++;
    request.answer(open);
    return null;
  },
  externalAppAllowances: (_args, profile) => (readStore().externalApps[profile] ?? []).map((entry) => ({ ...entry, icon: null })),
  removeExternalAppAllowance: (args, profile) => {
    const store = readStore();
    store.externalApps[profile] = (store.externalApps[profile] ?? []).filter((entry) => !(entry.origin === args.origin && entry.scheme === args.scheme));
    writeStore(store);
    return null;
  },
  devExternalLaunches: () => [],
});

defineModule("ArdiaExternalAppCounts", { sync: { takeLaunches: () => takeExternalLaunches() } });
