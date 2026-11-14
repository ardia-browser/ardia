import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchConfig } from "../launch";
import { dataDirectory, hostEnvironment, xdgConfigHome, xdgDataHome } from "../paths";

export const DESKTOP_FILE = "ardia.desktop";
export const WINDOW_CLASS = "ardia";
export const MIME_TYPES = ["text/html", "text/xml", "application/xhtml+xml", "x-scheme-handler/http", "x-scheme-handler/https"];

const XDG_QUERY_MS = 5000;
const XDG_TOOL_MS = 20000;

export type ToolRun = { ok: boolean; stdout: string; stderr: string; timedOut: boolean };

export function runTool(command: string, args: string[], deadlineMs: number): Promise<ToolRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (ok: boolean, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    };
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
      finish(false, true);
    }, deadlineMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      stderr += error.message;
      finish(false);
    });
    child.on("exit", (code) => finish(code === 0));
  });
}

export const desktopIsSandboxed = (): boolean => launchConfig().isolated;
const sandboxDesktop = () => join(dataDirectory(), "Desktop");
const dataHome = () => (desktopIsSandboxed() ? join(sandboxDesktop(), "share") : xdgDataHome());
const configHome = () => (desktopIsSandboxed() ? join(sandboxDesktop(), "config") : xdgConfigHome());

export const userDesktopFile = () => join(dataHome(), "applications", DESKTOP_FILE);
export const autostartFile = () => join(configHome(), "autostart", DESKTOP_FILE);

export function launcherPath(): string {
  return hostEnvironment.appImage || hostEnvironment.launcher || process.execPath;
}

const quoted = (path: string) => (/[\s"'\\$`]/.test(path) ? `"${path.replace(/(["\\$`])/g, "\\$1")}"` : path);

export function desktopEntry(extra: Record<string, string> = {}): string {
  const exec = quoted(launcherPath());
  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Ardia",
    "GenericName=Web Browser",
    "Comment=Browse the web",
    `Exec=${exec} %U`,
    "Icon=ardia",
    "Terminal=false",
    "Categories=Network;WebBrowser;",
    `MimeType=${MIME_TYPES.join(";")};`,
    `StartupWMClass=${WINDOW_CLASS}`,
    "StartupNotify=true",
    "Actions=new-window;",
    ...Object.entries(extra).map(([key, value]) => `${key}=${value}`),
    "",
    "[Desktop Action new-window]",
    "Name=New Window",
    `Exec=${exec} --new-window`,
    "",
  ];
  return lines.join("\n");
}

export const installedSystemWide = () => ["/usr/share/applications", "/usr/local/share/applications"].some((folder) => existsSync(join(folder, DESKTOP_FILE)));

function installIcons(): void {
  const icons = join(__dirname, "icons");
  if (!existsSync(icons)) return;
  for (const file of readdirSync(icons)) {
    const size = file.replace(/\.png$/, "");
    const folder = join(dataHome(), "icons/hicolor", size, "apps");
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(icons, file), join(folder, "ardia.png"));
  }
}

export async function ensureUserDesktopEntry(): Promise<void> {
  if (installedSystemWide() && !hostEnvironment.appImage) return;
  mkdirSync(join(dataHome(), "applications"), { recursive: true });
  writeFileSync(userDesktopFile(), desktopEntry());
  installIcons();
  if (desktopIsSandboxed()) return;
  await runTool("update-desktop-database", [join(dataHome(), "applications")], XDG_TOOL_MS);
}

export async function xdg(command: string, ...args: string[]): Promise<string | null> {
  if (desktopIsSandboxed()) return null;
  const done = await runTool(command, args, args[0] === "set" || args[0] === "default" ? XDG_TOOL_MS : XDG_QUERY_MS);
  return done.ok ? done.stdout : null;
}

export const mimeAppsFile = () => join(configHome(), "mimeapps.list");

export function writeDefaultApplications(desktopFile: string, types: readonly string[]): void {
  const path = mimeAppsFile();
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const header = "[Default Applications]";
  let start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    start = lines.push(header) - 1;
  }
  let end = lines.findIndex((line, i) => i > start && line.trim().startsWith("["));
  if (end < 0) end = lines.length;
  const section = lines.slice(start + 1, end).filter((line) => !types.some((type) => line.startsWith(`${type}=`)));
  while (section.length && section[section.length - 1] === "") section.pop();
  const updated = [...lines.slice(0, start + 1), ...types.map((type) => `${type}=${desktopFile}`), ...section, ...(end < lines.length ? [""] : []), ...lines.slice(end)];
  mkdirSync(configHome(), { recursive: true });
  writeFileSync(path, `${updated.join("\n").replace(/\n+$/, "")}\n`);
}

export function defaultApplicationIn(type: string): string | null {
  const path = mimeAppsFile();
  if (!existsSync(path)) return null;
  let inDefaults = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) inDefaults = trimmed === "[Default Applications]";
    else if (inDefaults && trimmed.startsWith(`${type}=`)) return trimmed.slice(type.length + 1).split(";")[0] || null;
  }
  return null;
}

export function writeAutostart(enabled: boolean): void {
  if (!enabled) return void rmSync(autostartFile(), { force: true });
  mkdirSync(join(configHome(), "autostart"), { recursive: true });
  writeFileSync(autostartFile(), desktopEntry({ "X-GNOME-Autostart-enabled": "true", "X-Ardia-Autostart": "true" }).replace(" %U", " --autostart"));
}

