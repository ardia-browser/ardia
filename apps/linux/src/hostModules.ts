import { hostLaunchConfig } from "./hostLaunchConfig.ts";
import { calendarModuleMethod } from "./hostCalendar.ts";
import type { ArdiaHost } from "./host";
import { callHost, hostModuleMethod, hostSupports } from "./host.ts";
import { linuxMediaCall } from "./hostCast.ts";
import { credentialModuleMethod } from "./hostCredentials.ts";
import { syncModuleMethod } from "./hostSync.ts";
import { linuxSystemMethod } from "./hostFiles.ts";
import { linuxModuleMethod } from "./hostSystem.ts";
import { linuxShellMethod, watchSidebarEdgeBesideNativeLeftEdge } from "./shellMethods.ts";
import { appModuleFallback } from "./appModuleFallbacks.ts";
import { cliModuleMethod } from "./hostCli.ts";
import { configModuleMethod } from "./hostConfig.ts";
import { BOOKMARKS_EXPORT_CALL, bookmarksExportCall } from "./hostBookmarksExport.ts";

const synchronousDefaults: Record<string, Record<string, unknown>> = {
  ArdiaApp: { apiVersion: 0 },
  ArdiaTranslate: { available: false },
  ArdiaSystem: { backgroundInstance: false },
};

const synchronousMethods: Record<string, Record<string, unknown>> = {
  ArdiaGlassEffect: { isLiquidGlass: false },
  ArdiaCli: { installedVersion: null },
  ArdiaConfig: { readFile: { status: "missing" } },
  ArdiaAutomation: { reply: undefined, broadcast: undefined },
};

export const PAGE_OPTION_CALLS = [
  "webView.setVideoUpscaling",
  "webView.setCommandScrollZoom",
  "webView.setDisplayMediaPicker",
  "webView.setPeekOtherSiteTabs",
  "webView.setInAppLinkPatterns",
  "webView.setLittleArdiaOpensNewTabLinks",
  "webView.setPopupsOpenAsTabs",
  "webView.setBlockAutoplayEverywhere",
] as const;
const pageOptionCalls: ReadonlySet<string> = new Set(PAGE_OPTION_CALLS);

const nativeFallthroughs = new WeakSet<object>();
export const reachesNativeHostUnchecked = (resolved: unknown) => typeof resolved === "function" && nativeFallthroughs.has(resolved);

export function resolveHostModule(host: ArdiaHost, name: string, method: string): unknown {
  if (name === "ArdiaApp" && method === "launchConfig") return () => hostLaunchConfig(host);
  if (name === "ArdiaShell" && method === "watchSidebarEdge" && !hostSupports("ArdiaShell.watchSidebarEdge", host) && hostSupports("ArdiaShell.watchLeftEdge", host)) {
    return watchSidebarEdgeBesideNativeLeftEdge(host);
  }
  if (name === "ArdiaShell" && !hostSupports(`${name}.${method}`, host)) {
    const local = linuxShellMethod(method, host);
    if (local) return local;
  }
  if (name === "ArdiaSystem") {
    const local = linuxSystemMethod(host, method);
    if (local !== undefined) return local;
  }
  const platform = linuxModuleMethod(host, name, method);
  if (platform) return platform;
  const credential = credentialModuleMethod(host, name, method);
  if (credential !== undefined) return credential;
  const syncMethod = syncModuleMethod(host, name, method);
  if (syncMethod !== undefined) return syncMethod;
  const calendar = calendarModuleMethod(host, name, method);
  if (calendar !== undefined) return calendar;
  const cli = cliModuleMethod(host, name, method);
  if (cli !== undefined) return cli;
  const config = configModuleMethod(host, name, method);
  if (config !== undefined) return config;
  const fallback = appModuleFallback(host, name, method);
  if (fallback) return fallback;
  if (name === "ArdiaDocuments" && method === "call") {
    return (verb: string, profile: string, args: string) => {
      if (!["watch", "commit", "flush", "unwatch"].includes(verb)) return Promise.reject(Object.assign(new Error("Unknown document operation"), { code: "ERR_UNKNOWN_CALL" }));
      if (typeof args !== "string") return Promise.reject(Object.assign(new Error("Document arguments require JSON text"), { code: "ERR_DOCUMENT_REQUEST" }));
      return callHost(`documents.${verb}`, profile, args, host);
    };
  }
  if (name === "ArdiaMedia" && method === "call") {
    return (verb: string, profile: string, args: string) => linuxMediaCall(verb, args, (method) => hostSupports(method, host)) ?? callHost(`media.${verb}`, profile, args, host);
  }
  if (name === "ArdiaBookmarks" && method === "call" && !hostSupports(BOOKMARKS_EXPORT_CALL, host)) {
    const exportHtml = bookmarksExportCall(host);
    return (verb: string, profile: string, args: string) => verb === "exportHtml" ? exportHtml(profile) : callHost(`bookmarks.${verb}`, profile, args, host);
  }
  if (method === "call" && /^Ardia[A-Z]/.test(name)) {
    const domain = name.slice(5, 6).toLowerCase() + name.slice(6);
    return (verb: string, profile: string, args: string) => {
      const call = `${domain}.${verb}`;
      if (pageOptionCalls.has(call) && !hostSupports(call, host)) return Promise.resolve("null");
      return callHost(call, profile, args, host);
    };
  }
  const constants = host.bootstrap.nativeModules?.[name];
  const sync = synchronousMethods[name];
  if (sync && method in sync) return () => constants?.[method] ?? sync[method];
  if (constants && method in constants) return constants[method];
  const defaults = synchronousDefaults[name];
  if (defaults && method in defaults) return defaults[method];
  const fallthrough = hostModuleMethod(name, method, host);
  nativeFallthroughs.add(fallthrough);
  return fallthrough;
}
