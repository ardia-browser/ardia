import { app, type WebContents } from "electron";
import { rememberSiteSetting, siteSetting } from "../services/sites";
import { tell, type Guest } from "./guests";

const ACTIVATION_LIFESPAN_MS = 5000;
const DRAG_LIFESPAN_MS = 2000;
const DROP_REFERRER = "about:client";
export const PAGE_DRAG_CHANNEL = "ardia:page-drag";
const KEPT_PER_PAGE = 50;
const NOT_ACTIVATING_KEYS = new Set(["Escape", "Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "OS", "Super", "Hyper"]);

export type BlockedOpen = {
  id: string;
  guestId: number;
  url: string;
  features: string;
  disposition: string;
  origin: string;
};

const activatedAt = new Map<number, number>();
const draggedOverAt = new Map<number, number>();
const blocked = new Map<string, BlockedOpen>();
let nextId = 0;

function activates(input: Electron.InputEvent): boolean {
  if (input.type === "mouseDown" || input.type === "mouseUp") return true;
  if (input.type === "keyDown" || input.type === "rawKeyDown") return !NOT_ACTIVATING_KEYS.has((input as Electron.KeyboardInputEvent).keyCode);
  return false;
}

export function watchActivation(contents: WebContents): void {
  contents.on("input-event", (_event, input) => {
    if (activates(input)) activatedAt.set(contents.id, Date.now());
  });
  contents.on("ipc-message", (_event, channel) => {
    if (channel === PAGE_DRAG_CHANNEL) draggedOverAt.set(contents.id, Date.now());
  });
  contents.once("destroyed", () => {
    activatedAt.delete(contents.id);
    draggedOverAt.delete(contents.id);
    for (const [id, entry] of blocked) if (entry.guestId === contents.id) blocked.delete(id);
  });
}

export function consumeActivation(contents: WebContents): boolean {
  const at = activatedAt.get(contents.id);
  if (at === undefined || Date.now() - at > ACTIVATION_LIFESPAN_MS) return false;
  activatedAt.delete(contents.id);
  return true;
}

export function takeDrop(contents: WebContents, referrer: string): boolean {
  const at = draggedOverAt.get(contents.id);
  if (referrer !== DROP_REFERRER || at === undefined || Date.now() - at > DRAG_LIFESPAN_MS) return false;
  draggedOverAt.delete(contents.id);
  return true;
}

const originOf = (url: string) => {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
};

export function mayOpen(guest: Guest): boolean {
  if (consumeActivation(guest.contents)) return true;
  const origin = originOf(guest.committedUrl || guest.url);
  return !!origin && siteSetting(guest.profile, origin, "popups") === "allow";
}

export function block(guest: Guest, url: string, features: string, disposition: string): void {
  const origin = originOf(guest.committedUrl || guest.url);
  const id = `popup-${++nextId}`;
  const mine = [...blocked.values()].filter((entry) => entry.guestId === guest.contents.id);
  for (const stale of mine.slice(0, Math.max(0, mine.length - KEPT_PER_PAGE + 1))) blocked.delete(stale.id);
  blocked.set(id, { id, guestId: guest.contents.id, url, features, disposition, origin });
  tell(guest, "popupBlocked", { id, url, origin });
}

export function takeBlocked(guest: Guest, id: string, always: boolean): BlockedOpen | null {
  const entry = blocked.get(id);
  if (!entry || entry.guestId !== guest.contents.id) return null;
  blocked.delete(id);
  if (always && entry.origin) rememberSiteSetting(guest.profile, entry.origin, "popups", "allow");
  return entry;
}

export function forgetBlocked(contents: WebContents): void {
  for (const [id, entry] of blocked) if (entry.guestId === contents.id) blocked.delete(id);
}

app.on("web-contents-created", (_event, contents) => {
  const type = contents.getType();
  if (type === "webview" || type === "window" || type === "browserView") watchActivation(contents);
});
