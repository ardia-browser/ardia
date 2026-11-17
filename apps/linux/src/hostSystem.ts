import { hostSupports, type ArdiaHost } from "./host.ts";
import { linuxCapabilities, unavailableError } from "./hostCapabilities.ts";
import { openMailLink } from "./linkShare.ts";
import { linuxIntroMusic } from "./introMusic.ts";
import { noteIntroMusicFailed } from "../../browser/src/state/telemetry/introCounts.ts";
import { UPDATE_METHODS, updatesAvailable } from "./hostUpdates.ts";
import { linuxCrashReports, servesCrashDumps } from "./hostCrashReports.ts";

const UPDATER_METHODS: ReadonlySet<string> = new Set(UPDATE_METHODS);

const INTRO_MUSIC = new Set(["playIntroMusic", "setIntroMusicMuted", "stopIntroMusic"]);
const introMusicPlayers = new WeakMap<ArdiaHost, ReturnType<typeof linuxIntroMusic>>();
const introMusicFor = (host: ArdiaHost) => {
  let player = introMusicPlayers.get(host);
  if (!player) introMusicPlayers.set(host, (player = linuxIntroMusic({ host, onPlayed: (played) => void (played || noteIntroMusicFailed()) })));
  return player;
};

export function linuxModuleMethod(host: ArdiaHost, name: string, method: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
  if (name === "ArdiaSystem") return linuxSystemMethod(host, method);
  if (name !== "ArdiaApp" || hostSupports(`${name}.${method}`, host)) return undefined;
  if (UPDATER_METHODS.has(method) && updatesAvailable(host)) {
    return (...args) => import("./linuxUpdates.ts").then(({ linuxUpdaterFor }) => (linuxUpdaterFor(host).methods[method as (typeof UPDATE_METHODS)[number]] as (...args: unknown[]) => Promise<unknown>)(...args));
  }
  if (INTRO_MUSIC.has(method)) return introMusicFor(host)[method as "playIntroMusic" | "setIntroMusicMuted" | "stopIntroMusic"] as (...args: unknown[]) => Promise<unknown>;
  if (method === "openExternalURL") return (url) => Promise.resolve(typeof url === "string" && openMailLink(url));
  if (method === "crashReports" && servesCrashDumps(host)) return (since) => linuxCrashReports(host, typeof since === "number" && Number.isFinite(since) ? since : 0);
  return undefined;
}

function linuxSystemMethod(host: ArdiaHost, method: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
  const capabilities = linuxCapabilities(host);
  switch (method) {
    case "isDefaultBrowser":
    case "setAsDefaultBrowser":
      return capabilities.defaultBrowser ? undefined : () => Promise.reject(unavailableError("Setting the default browser"));
    case "launchAtLoginStatus":
      return capabilities.launchAtLogin ? undefined : () => Promise.resolve("notFound");
    case "setLaunchAtLogin":
      return capabilities.launchAtLogin ? undefined : () => Promise.reject(unavailableError("Opening at login"));
    case "setThinScrollBars":
      return capabilities.thinScrollBars ? undefined : () => Promise.resolve();
    case "hapticTick":
      return hostSupports("ArdiaSystem.hapticTick", host) ? undefined : () => Promise.resolve();
  }
  return undefined;
}
