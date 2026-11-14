import { freemem, totalmem } from "node:os";
import { defineModule, emit } from "../bridge";
import { note } from "../log";
import { defineDomain } from "./domains";
import { allGuests, guestById, PAGES_MODULE, type Guest } from "./guests";
import { count } from "../counts";

type Mode = "moderate" | "balanced" | "maximum";
type Settings = { state: "on" | "off"; aggressiveness: Mode; sites: string[] };
type Reason = "proactive" | "urgent";

const MODES: readonly Mode[] = ["moderate", "balanced", "maximum"];
const MINUTE = 60 * 1000;
const HIDDEN_BEFORE_DISCARD_MS: Record<Mode, number> = { moderate: 4 * 60 * MINUTE, balanced: 2 * 60 * MINUTE, maximum: 30 * MINUTE };
const HIDDEN_BEFORE_URGENT_DISCARD_MS = 5 * MINUTE;
const LOW_MEMORY_FREE_SHARE = 0.1;
const CHECK_EVERY_MS = MINUTE;

let settings: Settings = { state: "on", aggressiveness: "balanced", sites: [] };
const hiddenSince = new Map<number, number>();
const inPictureInPicture = new Set<number>();
let timer: ReturnType<typeof setInterval> | null = null;

function siteParts(site: string): { host: string; path: string } | null {
  try {
    const url = new URL(/^[a-z][\w+.-]*:\/\//i.test(site) ? site : `https://${site}`);
    return { host: url.hostname.replace(/^www\./, ""), path: url.pathname === "/" ? "" : url.pathname };
  } catch {
    return null;
  }
}

function keptActive(url: string): boolean {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return false;
  }
  const host = page.hostname.replace(/^www\./, "");
  return settings.sites.some((site) => {
    const parts = siteParts(site);
    if (!parts) return false;
    const hostMatches = host === parts.host || host.endsWith(`.${parts.host}`);
    return hostMatches && (!parts.path || page.pathname.startsWith(parts.path));
  });
}

function discardable(guest: Guest, now: number, hiddenFor: number): boolean {
  const since = hiddenSince.get(guest.contents.id);
  if (since === undefined || now - since < hiddenFor) return false;
  const contents = guest.contents;
  if (contents.isDestroyed() || !guest.attached || !/^https?:/.test(guest.url)) return false;
  if (contents.isCurrentlyAudible() || inPictureInPicture.has(contents.id) || contents.isDevToolsOpened()) return false;
  return !keptActive(guest.url);
}

function discard(guest: Guest, reason: Reason) {
  const hiddenMinutes = Math.round((Date.now() - (hiddenSince.get(guest.contents.id) ?? Date.now())) / MINUTE);
  hiddenSince.delete(guest.contents.id);
  note("memory", `sleeping a tab hidden ${hiddenMinutes} min (${reason})`);
  count(reason === "urgent" ? "memory_saver_discards_urgent" : "memory_saver_discards_proactive");
  emit(PAGES_MODULE, "discard", { guest: guest.contents.id, reason });
}

function check() {
  if (settings.state !== "on") return;
  const now = Date.now();
  const guests = allGuests();
  for (const guest of guests) if (discardable(guest, now, HIDDEN_BEFORE_DISCARD_MS[settings.aggressiveness])) discard(guest, "proactive");
  if (freemem() / totalmem() >= LOW_MEMORY_FREE_SHARE) return;
  const oldest = guests
    .filter((guest) => hiddenSince.has(guest.contents.id) && discardable(guest, now, HIDDEN_BEFORE_URGENT_DISCARD_MS))
    .sort((a, b) => hiddenSince.get(a.contents.id)! - hiddenSince.get(b.contents.id)!)[0];
  if (oldest) discard(oldest, "urgent");
}

function schedule() {
  if (settings.state === "on" && !timer) timer = setInterval(check, CHECK_EVERY_MS);
  if (settings.state !== "on" && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function shown(guestId: number, visible: boolean) {
  const guest = guestById(guestId);
  if (!guest) return;
  if (visible) hiddenSince.delete(guestId);
  else if (!hiddenSince.has(guestId)) {
    hiddenSince.set(guestId, Date.now());
    guest.contents.once("destroyed", () => {
      hiddenSince.delete(guestId);
      inPictureInPicture.delete(guestId);
    });
  }
}

export const isHiddenPage = (guestId: number): boolean => hiddenSince.has(guestId);

export function notePictureInPicture(guestId: number, active: boolean) {
  if (active) inPictureInPicture.add(guestId);
  else inPictureInPicture.delete(guestId);
}

function stateOf() {
  return { ...settings, active: settings.state === "on", invalid: settings.sites.filter((site) => !siteParts(site)) };
}

defineDomain("engine", {
  memorySaver: (args) => {
    const state = args.state === "off" ? "off" : args.state === "on" ? "on" : settings.state;
    const aggressiveness = MODES.includes(args.aggressiveness as Mode) ? (args.aggressiveness as Mode) : settings.aggressiveness;
    const sites = Array.isArray(args.sites) ? args.sites.filter((site): site is string => typeof site === "string") : settings.sites;
    settings = { state, aggressiveness, sites };
    schedule();
    return stateOf();
  },
  validateKeepActiveSite: (args) => ({ valid: typeof args.site === "string" && !!siteParts(args.site) && !/\s/.test(args.site) }),
});

defineModule(PAGES_MODULE, {
  sync: { shown: (guestId: number, visible: boolean) => shown(guestId, visible === true) },
  async: { checkMemorySaver: async () => check() },
});

schedule();
