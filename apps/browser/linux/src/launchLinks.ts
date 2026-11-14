import { app } from "electron";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { emit } from "./bridge";
import { note } from "./log";
import { focusAppWindow } from "./windowFocus";
import { appWindowIds } from "./windows";

const SCHEME = /^([a-z][a-z0-9+.-]+):(.*)$/is;
const WEB_REST = /^\/*([^\s/\\?#]+)(.*)$/s;
const BARE_HOST = /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*)(?::\d{1,5})?(?:[/?#][^\s\\]*)?$/i;
const ELECTRON_SWITCH = /^--?[a-z]/i;

const escapedSpaces = (text: string) => text.replace(/\s/g, (space) => encodeURIComponent(space));

export function addressOf(argument: string, cwd: string): string | null {
  const text = argument.trim();
  if (!text) return null;
  const scheme = SCHEME.exec(text);
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    if (name === "http" || name === "https") {
      const web = WEB_REST.exec(scheme[2]!);
      return web ? `${name}://${web[1]}${escapedSpaces(web[2]!)}` : null;
    }
    if (name === "file") return escapedSpaces(text);
    return null;
  }
  const path = isAbsolute(text) ? text : resolve(cwd, text);
  if ((isAbsolute(text) || text.startsWith(".") || text.includes("/")) && existsSync(path)) return pathToFileURL(path).href;
  if (existsSync(path) && !BARE_HOST.test(text)) return pathToFileURL(path).href;
  return BARE_HOST.test(text) ? `http://${text}` : null;
}

export function launchAddresses(argv: string[], cwd: string): string[] {
  const addresses: string[] = [];
  let switchesEnded = false;
  for (const argument of argv) {
    if (!switchesEnded && argument === "--") {
      switchesEnded = true;
      continue;
    }
    if (!switchesEnded && ELECTRON_SWITCH.test(argument)) continue;
    const address = addressOf(argument, cwd);
    if (address) addresses.push(address);
  }
  return addresses;
}

function userArguments(argv: string[], cwd: string): string[] {
  const appPath = app.getAppPath();
  return argv.slice(1).filter((argument) => app.isPackaged || resolve(cwd, argument) !== appPath);
}

let listening = false;
let heldLinks: string[] = [];
let heldCommand: (() => void) | null = null;
let launchLinksWaiting = 0;
let openedAtLaunch = 0;

function deliver(urls: string[]): void {
  emit("ArdiaShell", "onOpenURLs", { urls });
}

function hold(urls: string[]): void {
  heldLinks.push(...urls);
  note("launch", `launch links: ${heldLinks.length} held until the app listens`);
}

export function uiListening(): void {
  if (listening) return;
  listening = true;
  const urls = heldLinks;
  const command = heldCommand;
  heldLinks = [];
  heldCommand = null;
  openedAtLaunch += launchLinksWaiting;
  launchLinksWaiting = 0;
  if (urls.length) {
    note("launch", `launch links: ${urls.length} sent to the app`);
    deliver(urls);
  } else command?.();
}

export function uiStopped(): void {
  listening = false;
}

export function takeOpenedAtLaunch(): number {
  const taken = openedAtLaunch;
  openedAtLaunch = 0;
  return taken;
}

function whenListening(urls: string[], command: () => void): void {
  if (listening) return urls.length ? deliver(urls) : command();
  if (urls.length) hold(urls);
  else heldCommand = command;
}

export function installLaunchLinks(): void {
  const urls = launchAddresses(userArguments(process.argv, process.cwd()), process.cwd());
  if (urls.length) {
    launchLinksWaiting = urls.length;
    hold(urls);
  }
  app.on("second-instance", (_event, argv, cwd) => {
    const opened = launchAddresses(userArguments(argv, cwd), cwd);
    note("launch", `a second launch asked for ${opened.length} link(s)`);
    whenListening(opened, () => {
      if (argv.includes("--new-window")) emit("ArdiaMenus", "onCommand", { command: "newWindow", arg: null, windowId: null, focusGeneration: null });
      else emit("ArdiaShell", "onAppEvent", { type: "reopen", pastFloating: false });
    });
    const [first] = appWindowIds();
    if (first) focusAppWindow(first);
  });
}
