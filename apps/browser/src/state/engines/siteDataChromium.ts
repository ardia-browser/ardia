import { writeWebKitSiteData, type CookieRemoval, type PageCookie, type SiteData, type SiteStorage, type StorageChange, type StorageItems } from "../../platform/webkit";
import type { WebViewHandle } from "../../platform/tabs";
import { readChromiumStorage, writeChromiumStorage } from "../../platform/siteSettings";
import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { tabEngine } from "./engines";
import { chromiumCookie, webOrigin } from "./siteDataMerge";
import type { ConsentToken } from "../telemetry/client";
import { noteCookieJarRead } from "../telemetry/siteDataCounts";
import { beginActivity } from "../app/jobActivity";

type ChromiumPage = { page: WebViewHandle; origin: string | null };

function chromiumPages(profile: string): ChromiumPage[] {
  const s = useBrowser.getState();
  const pages: ChromiumPage[] = [];
  for (const t of Object.values(s.tabs)) {
    if (isIncognitoProfile(t.profileId) || engineProfile(s, t.profileId) !== profile || tabEngine(s, t.id) !== "chromium") continue;
    const page = webviews.get(t.id);
    if (page) pages.push({ page, origin: t.url ? webOrigin(t.url) : null });
  }
  return pages;
}

const pageRead = (page: WebViewHandle, domains: string[], origins: string[]) =>
  typeof page.siteData === "function" ? page.siteData({ op: "read", domains, origins }).catch(() => null) : Promise.resolve(null);

async function chromiumStorage(profile: string, origin: string, pages: ChromiumPage[]): Promise<StorageItems | null> {
  const onOrigin = pages.find((p) => p.origin === origin);
  const shown = onOrigin ? (await pageRead(onOrigin.page, [], [origin]))?.storage?.[origin] : null;
  if (shown) return shown;
  return (await readChromiumStorage(profile, origin).catch(() => null))?.items ?? null;
}

const ENGINE_STORAGE_BATCH = 4000;
const ENGINE_STORAGE_BATCH_BYTES = 7 * 1024 * 1024;
const ENGINE_STORAGE_QUOTA = 10 * 1024 * 1024;

const encodedSize = (text: string) => {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xff) return 1 + text.length * 2;
  return 1 + text.length;
};
const itemSize = ([key, value]: [string, string]) => encodedSize(key) + encodedSize(value);
const storedSize = ([key, value]: [string, string]) => 2 + 2 * (key.length + value.length);
const argumentBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

type EngineStorageWrite = { written: number; overQuota: number };

export function fitStorageChange(stored: StorageItems, change: StorageChange, quota = ENGINE_STORAGE_QUOTA): { change: StorageChange; overQuota: number } {
  const sizes = new Map<string, number>();
  for (const item of stored) sizes.set(item[0], (sizes.get(item[0]) ?? 0) + storedSize(item));
  let used = [...sizes.values()].reduce((n, size) => n + size, 0);
  const remove = change.remove.filter((key) => key !== "");
  const set: StorageItems = [];
  let overQuota = 0;
  for (const item of change.set) {
    if (item[0] === "") continue;
    const size = itemSize(item);
    const old = sizes.get(item[0]) ?? 0;
    if (size > old && used + size > quota) {
      overQuota++;
      continue;
    }
    used += size;
    sizes.set(item[0], old + size);
    set.push(item);
  }
  return { change: { set, remove }, overQuota };
}

function nextBatch(change: StorageChange): { batch: StorageChange; tooBig: number } {
  if (change.remove.length) return { batch: { set: [], remove: change.remove.slice(0, ENGINE_STORAGE_BATCH) }, tooBig: 0 };
  const set: StorageItems = [];
  let bytes = 0;
  let tooBig = 0;
  for (const item of change.set) {
    if (set.length >= ENGINE_STORAGE_BATCH) break;
    const size = argumentBytes(item) + 1;
    if (size > ENGINE_STORAGE_BATCH_BYTES) {
      tooBig++;
      continue;
    }
    if (bytes + size > ENGINE_STORAGE_BATCH_BYTES) break;
    bytes += size;
    set.push(item);
  }
  return { batch: { set, remove: [] }, tooBig };
}

async function writeEngineStorage(profile: string, origin: string, change: StorageChange, stillCurrent: () => boolean): Promise<EngineStorageWrite> {
  let left: StorageChange = { set: change.set, remove: change.remove };
  let written = 0;
  let overQuota = 0;
  while ((left.set.length || left.remove.length) && stillCurrent()) {
    const stored = (await readChromiumStorage(profile, origin).catch(() => null))?.items;
    if (!stored || !stillCurrent()) break;
    const fitted = fitStorageChange(stored, left);
    const { batch, tooBig } = nextBatch(fitted.change);
    if (!batch.set.length && !batch.remove.length) {
      overQuota += fitted.overQuota + tooBig;
      break;
    }
    const count = (await writeChromiumStorage(profile, origin, batch.set, batch.remove).catch(() => null))?.written ?? 0;
    written += count;
    if (count < batch.set.length + batch.remove.length) break;
    const sent = new Set(batch.set.map(([key]) => key));
    const removed = new Set(batch.remove);
    left = { set: left.set.filter(([key]) => !sent.has(key)), remove: left.remove.filter((key) => !removed.has(key)) };
  }
  return { written, overQuota };
}

type ChromiumRead = { data: SiteData; page: WebViewHandle; pages: ChromiumPage[] };

const COOKIE_READ_BATCH_MS = 25;
const MAX_READ_DOMAINS = 64;

type CookieJarRead = { cookies: PageCookie[]; page: WebViewHandle } | null;
type CookieReader = { domains: string[]; consent: ConsentToken | null; done: (read: CookieJarRead) => void };
type CookieReadBatch = { domains: Set<string>; readers: CookieReader[]; timer: ReturnType<typeof setTimeout> | null };

const openCookieReads = new Map<string, CookieReadBatch>();

const bareCookieDomain = (domain: string) => domain.toLowerCase().replace(/^\.+|\.+$/g, "");

function cookieCovered(domain: string, domains: readonly string[]): boolean {
  const bare = bareCookieDomain(domain);
  return !!bare && domains.some((wanted) => bare === wanted || bare.endsWith(`.${wanted}`));
}

const wantedDomains = (domains: readonly string[]) => [...new Set(domains.filter((d) => d.length).map((d) => d.toLowerCase()))].slice(0, MAX_READ_DOMAINS);

const NO_SPAN = () => {};

async function readCookieJar(profile: string, batch: CookieReadBatch) {
  const began = Date.now();
  const domains = [...batch.domains];
  const span = () => (domains.length ? beginActivity("siteDataCarry") : NO_SPAN);
  const pages = chromiumPages(profile).slice(0, 3);
  let read: CookieJarRead = null;
  for (const { page } of pages) {
    const dispatched = span();
    const reply = pageRead(page, domains, []);
    dispatched();
    const answer = await reply;
    if (!answer?.cookies) continue;
    read = { cookies: answer.cookies, page };
    break;
  }
  const handling = span();
  try {
    if (domains.length && pages.length) noteCookieJarRead(batch.readers.filter((r) => r.domains.length).map((r) => r.consent), read ? 1 : 0, Date.now() - began);
    for (const reader of batch.readers) reader.done(read && { page: read.page, cookies: read.cookies.filter((c) => cookieCovered(c.domain, reader.domains)) });
  } finally {
    handling();
  }
}

function sendCookieRead(profile: string, batch: CookieReadBatch) {
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = null;
  if (openCookieReads.get(profile) === batch) openCookieReads.delete(profile);
  void readCookieJar(profile, batch).catch(() => batch.readers.forEach((r) => r.done(null)));
}

function chromiumCookies(profile: string, domains: string[], urgent: boolean, consent: ConsentToken | null): Promise<CookieJarRead> {
  const wanted = wantedDomains(domains);
  return new Promise((done) => {
    const open = openCookieReads.get(profile);
    const joins = !!open && new Set([...open.domains, ...wanted]).size <= MAX_READ_DOMAINS;
    const batch: CookieReadBatch = joins ? open! : { domains: new Set(), readers: [], timer: null };
    for (const d of wanted) batch.domains.add(d);
    batch.readers.push({ domains: wanted, consent, done });
    if (urgent) return sendCookieRead(profile, batch);
    if (joins) return;
    openCookieReads.set(profile, batch);
    batch.timer = setTimeout(() => sendCookieRead(profile, batch), COOKIE_READ_BATCH_MS);
  });
}

export async function readChromium(profile: string, domains: string[], origins: string[], urgent = false, consent: ConsentToken | null = null): Promise<ChromiumRead | null> {
  const read = await chromiumCookies(profile, domains, urgent, consent);
  if (!read) return null;
  const pages = chromiumPages(profile);
  const storage: SiteStorage = {};
  await Promise.all(origins.map(async (o) => void (storage[o] = await chromiumStorage(profile, o, pages))));
  return { data: { cookies: read.cookies, storage }, page: read.page, pages };
}

type Written = { cookies: number; removed: number; storage: number; landed: Set<string>; overQuota?: number };

export async function writeChromium(
  profile: string,
  read: ChromiumRead,
  cookies: PageCookie[],
  remove: CookieRemoval[],
  storage: Record<string, StorageChange>,
  stillCurrent: () => boolean = () => true,
): Promise<Written | null> {
  const reply = cookies.length || remove.length ? await read.page.siteData({ op: "write", cookies: cookies.map(chromiumCookie), remove, storage: {} }).catch(() => null) : { cookiesWritten: 0, removed: 0 };
  if (!reply) return null;
  const landed = new Set<string>();
  let stored = 0;
  let overQuota = 0;
  for (const [origin, change] of Object.entries(storage)) {
    if (!stillCurrent()) break;
    const wanted = change.set.length + change.remove.length;
    const onOrigin = read.pages.find((p) => p.origin === origin);
    let count = onOrigin ? ((await onOrigin.page.siteData({ op: "write", cookies: [], remove: [], storage: { [origin]: change } }).catch(() => null))?.storageWritten ?? 0) : 0;
    if (count < wanted) {
      const engine = await writeEngineStorage(profile, origin, change, stillCurrent);
      count = Math.max(count, engine.written);
      overQuota += engine.overQuota;
    }
    if (count >= wanted) landed.add(origin);
    stored += count;
  }
  return { cookies: reply.cookiesWritten ?? 0, removed: reply.removed ?? 0, storage: stored, landed, overQuota };
}

export async function readChromiumStorageWithoutPage(profile: string, origins: string[]): Promise<SiteStorage> {
  const storage: SiteStorage = {};
  await Promise.all(origins.map(async (o) => void (storage[o] = await chromiumStorage(profile, o, []))));
  return storage;
}

export async function writeChromiumStorageWithoutPage(
  profile: string,
  storage: Record<string, StorageChange>,
  stillCurrent: () => boolean,
): Promise<{ storage: number; landed: Set<string>; overQuota: number }> {
  const landed = new Set<string>();
  let stored = 0;
  let overQuota = 0;
  for (const [origin, change] of Object.entries(storage)) {
    if (!stillCurrent()) break;
    const engine = await writeEngineStorage(profile, origin, change, stillCurrent);
    if (engine.written >= change.set.length + change.remove.length) landed.add(origin);
    stored += engine.written;
    overQuota += engine.overQuota;
  }
  return { storage: stored, landed, overQuota };
}

export async function writeWebKit(profile: string, cookies: PageCookie[], remove: CookieRemoval[], storage: Record<string, StorageChange>): Promise<Written | null> {
  const reply = await writeWebKitSiteData(profile, cookies, remove, storage).catch(() => null);
  if (!reply) return null;
  const wanted = Object.values(storage).reduce((n, c) => n + c.set.length + c.remove.length, 0);
  return { ...reply, landed: new Set(reply.storage >= wanted ? Object.keys(storage) : []) };
}
