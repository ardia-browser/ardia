import type { PluginManifest } from "../../lib/pluginManifest";
import { failure } from "../automation/automationMethods";
import { lastFocusedEligibleWindow } from "../automation/automationWindows";
import type { Body } from "../automation/controlSocket";
import { programControlOn } from "../app/programControlSetting";
import { useBrowser } from "../browser/store";
import { openSettings } from "../settings/settingsWindows";
import { consentToken } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { fileIcon } from "../../platform/files";
import { activeManifest, currentPlugins } from "./store";

export const APP_METHODS = ["app.controlStatus", "app.openSettings", "app.icon"] as const;

export const APP_ICON_PATH = /^\/(?:System\/)?Applications\/(?:[^/\u0000-\u001f]{1,200}\/){0,2}[^/\u0000-\u001f]{1,200}\.app$/;

export const appIconPathProblem = (path: unknown): string | null =>
  typeof path !== "string" || !APP_ICON_PATH.test(path) || path.split("/").some((p) => p === "." || p === "..") ? "path is an app in /Applications or /System/Applications, like /System/Applications/Notes.app." : null;

export const OPENABLE_SETTINGS = ["plugins", "advanced"] as const;

export const COMMAND_LINE_PLUGIN = "cli";

const OPEN_GAP_MS = 2000;

const lastOpen = new Map<string, number>();

type Caller = { name: string; run: number };

export function controlStatus(): { command: boolean; control: boolean } {
  return { command: activeManifest(currentPlugins(), COMMAND_LINE_PLUGIN) !== null, control: programControlOn(useBrowser.getState()) === true };
}

function openArdiaSettings(c: Caller, params: Record<string, unknown>, now: number): Body {
  const pane = params.pane;
  if (typeof pane !== "string" || !(OPENABLE_SETTINGS as readonly string[]).includes(pane)) return failure("bad_request", `pane is one of ${OPENABLE_SETTINGS.join(", ")}.`);
  if (!lastFocusedEligibleWindow(useBrowser.getState())) return failure("no_window", "No window to open Settings from.");
  const last = lastOpen.get(c.name) ?? -Infinity;
  if (now - last < OPEN_GAP_MS) return failure("refused", "Settings was just opened; wait a moment.");
  lastOpen.set(c.name, now);
  openSettings(pane as (typeof OPENABLE_SETTINGS)[number]);
  notePlugin("plugin_settings_opens", consentToken());
  return { result: { ok: true } };
}

async function appIcon(params: Record<string, unknown>): Promise<Body> {
  const problem = appIconPathProblem(params.path);
  if (problem) return failure("bad_request", problem);
  const size = params.size ?? 64;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 16 || size > 256) return failure("bad_request", "size is 16 to 256 points.");
  let icon: string | null = null;
  try {
    icon = await fileIcon(params.path as string, size);
  } catch {
    icon = null;
  }
  return { result: { icon: typeof icon === "string" && icon.startsWith("data:image/png;base64,") ? icon : null } };
}

export function appMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>, now = Date.now()): Body | Promise<Body> {
  if (!m.permissions.app) return failure("refused", `${method} needs the app permission.`);
  if (method === "app.controlStatus") return { result: controlStatus() };
  if (method === "app.icon") return appIcon(params);
  return openArdiaSettings(c, params, now);
}
