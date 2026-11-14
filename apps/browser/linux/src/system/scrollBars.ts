import { app } from "electron";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "../paths";

type ScrollBars = "system" | "thin";

const FILE = "scroll-bars.json";
const GSETTINGS_TIMEOUT_MS = 300;

const file = () => join(dataDirectory(), FILE);

export function savedScrollBars(): ScrollBars {
  try {
    return (JSON.parse(readFileSync(file(), "utf8")) as { pageScrollBars?: unknown }).pageScrollBars === "thin" ? "thin" : "system";
  } catch {
    return "system";
  }
}

export function desktopPrefersOverlay(env: Record<string, string | undefined> = process.env, readSetting: () => string | null = gnomeOverlayScrolling): boolean {
  if (env.GTK_OVERLAY_SCROLLING === "0") return false;
  return readSetting() !== "false";
}

function gnomeOverlayScrolling(): string | null {
  try {
    return execFileSync("gsettings", ["get", "org.gnome.desktop.interface", "overlay-scrolling"], { timeout: GSETTINGS_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function scrollBarMode(choice: ScrollBars, prefersOverlay: () => boolean = desktopPrefersOverlay): "overlay" | "classic" {
  return choice === "thin" || prefersOverlay() ? "overlay" : "classic";
}

export function applyScrollBars(): void {
  const feature = `OverlayScrollbar:mode/${scrollBarMode(savedScrollBars())}`;
  const existing = app.commandLine.getSwitchValue("enable-features");
  app.commandLine.appendSwitch("enable-features", existing ? `${existing},${feature}` : feature);
}

export function rememberScrollBars(thin: boolean): void {
  const pageScrollBars: ScrollBars = thin ? "thin" : "system";
  if (savedScrollBars() === pageScrollBars) return;
  try {
    writeFileSync(file(), JSON.stringify({ pageScrollBars }));
  } catch {}
}
