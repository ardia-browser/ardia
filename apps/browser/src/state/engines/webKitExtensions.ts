import { listExtensions, onExtensionsChanged, type InstalledExtension } from "../../platform/extensions";
import {
  onWebKitExtensionCall,
  onWebKitExtensionCallsCancelled,
  onWebKitExtensionListeners,
  onWebKitExtensionsWanted,
  replyToWebKitExtension,
  syncWebKitExtensions,
  type WebKitExtension,
  type WebKitExtensionCall,
} from "../../platform/webkit";
import { noteWebKitExtensions } from "../telemetry/engineSwitchCounts";
import { useBrowser } from "../browser/store";
import { answerExtensionCall, noteCancelledCalls } from "./webKitExtensionApis";
import { noteExtensionList, noteExtensionListeners } from "./webKitExtensionEvents";
import { consentToken, type ConsentToken } from "../telemetry/client";

const syncedProfiles = new Set<string>();
const signatures = new Map<string, string>();
const restagesAsked = new Map<string, number>();
const restagesDone = new Map<string, number>();
const running = new Map<string, Promise<void>>();
const again = new Set<string>();
let listening = false;

export function forWebKit(list: readonly InstalledExtension[]): WebKitExtension[] {
  return list
    .filter((x) => x.enabled && x.state === "ENABLED" && !x.blockedByPolicy)
    .map((x) => ({
      id: x.id,
      path: x.path,
      version: x.version,
      name: x.name,
      sites: x.siteAccess === "ON_SPECIFIC_SITES" ? [...x.sites].sort() : [],
      allSites: x.siteAccess === "ON_ALL_SITES" || x.siteAccess === null,
      incognito: x.incognito,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function pass(profile: string, consent: ConsentToken | null) {
  const list = await listExtensions(profile);
  noteExtensionList(profile, list);
  const extensions = useBrowser.getState().settings.webKitExtensions ? forWebKit(list) : [];
  const signature = JSON.stringify(extensions);
  const asked = restagesAsked.get(profile) ?? 0;
  if (asked === (restagesDone.get(profile) ?? 0) && signatures.get(profile) === signature) return;
  const result = await syncWebKitExtensions(profile, extensions);
  signatures.set(profile, signature);
  restagesDone.set(profile, asked);
  if (result.available) noteWebKitExtensions(result.loaded.length, result.failed.length, consent);
}

let watchingSetting = false;

function watchSetting() {
  if (watchingSetting) return;
  watchingSetting = true;
  useBrowser.subscribeTo(["settings"], (s, prev) => {
    if (s.settings.webKitExtensions === prev.settings.webKitExtensions) return;
    for (const profile of syncedProfiles) void syncExtensionsToWebKit(profile);
  });
}

export function syncExtensionsToWebKit(profile: string): Promise<void> {
  listen();
  watchSetting();
  syncedProfiles.add(profile);
  const current = running.get(profile);
  if (current) {
    again.add(profile);
    return current;
  }
  const run = pass(profile, consentToken())
    .catch(() => {})
    .finally(() => {
      running.delete(profile);
      if (again.delete(profile)) void syncExtensionsToWebKit(profile);
    });
  running.set(profile, run);
  return run;
}

export async function answerWebKitExtension(call: WebKitExtensionCall) {
  const reply = await answerExtensionCall(call);
  await replyToWebKitExtension(call.id, reply).catch(() => {});
}

const settleTries = 40;
const settleMs = 250;

async function syncWhenReloaded(profile: string, id: string) {
  for (let tries = 0; tries < settleTries; tries++) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const listed = (await listExtensions(profile).catch(() => [])).find((x) => x.id === id);
    if (!listed || listed.state === "ENABLED") break;
  }
  await syncExtensionsToWebKit(profile);
}

function listen() {
  if (listening) return;
  listening = true;
  onExtensionsChanged(({ profile, event, id }) => {
    if (!syncedProfiles.has(profile)) return;
    void syncExtensionsToWebKit(profile);
    if (event === "reloaded") void syncWhenReloaded(profile, id);
  });
  onWebKitExtensionCall((call) => void answerWebKitExtension(call));
  onWebKitExtensionCallsCancelled(({ ids }) => noteCancelledCalls(ids));
  onWebKitExtensionListeners(noteExtensionListeners);
  onWebKitExtensionsWanted(({ profile }) => {
    restagesAsked.set(profile, (restagesAsked.get(profile) ?? 0) + 1);
    void syncExtensionsToWebKit(profile);
  });
}

listen();
