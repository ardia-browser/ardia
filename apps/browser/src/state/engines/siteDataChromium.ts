import { writeWebKitSiteData, type CookieRemoval, type PageCookie, type SiteData, type SiteStorage, type StorageChange, type StorageItems } from "../../platform/webkit";
import type { WebViewHandle } from "../../platform/tabs";
import { readChromiumStorage, writeChromiumStorage } from "../../platform/siteSettings";
import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { tabEngine } from "./engines";
import { chromiumCookie, webOrigin } from "./siteDataMerge";

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

async function writeEngineStorage(profile: string, origin: string, change: StorageChange, stillCurrent: () => boolean): Promise<number> {
  const steps: StorageChange[] = [];
  for (let i = 0; i < change.set.length; i += ENGINE_STORAGE_BATCH) steps.push({ set: change.set.slice(i, i + ENGINE_STORAGE_BATCH), remove: [] });
  for (let i = 0; i < change.remove.length; i += ENGINE_STORAGE_BATCH) steps.push({ set: [], remove: change.remove.slice(i, i + ENGINE_STORAGE_BATCH) });
  let written = 0;
  for (const step of steps) {
    if (!stillCurrent()) break;
    const count = (await writeChromiumStorage(profile, origin, step.set, step.remove).catch(() => null))?.written ?? 0;
    written += count;
    if (count < step.set.length + step.remove.length) break;
  }
  return written;
}

export type ChromiumRead = { data: SiteData; page: WebViewHandle; pages: ChromiumPage[] };

export async function readChromium(profile: string, domains: string[], origins: string[]): Promise<ChromiumRead | null> {
  const pages = chromiumPages(profile);
  for (const { page } of pages.slice(0, 3)) {
    const reply = await pageRead(page, domains, []);
    if (!reply?.cookies) continue;
    const storage: SiteStorage = {};
    await Promise.all(origins.map(async (o) => void (storage[o] = await chromiumStorage(profile, o, pages))));
    return { data: { cookies: reply.cookies, storage }, page, pages };
  }
  return null;
}

export type Written = { cookies: number; removed: number; storage: number; landed: Set<string> };

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
  for (const [origin, change] of Object.entries(storage)) {
    if (!stillCurrent()) break;
    const wanted = change.set.length + change.remove.length;
    const onOrigin = read.pages.find((p) => p.origin === origin);
    let count = onOrigin ? ((await onOrigin.page.siteData({ op: "write", cookies: [], remove: [], storage: { [origin]: change } }).catch(() => null))?.storageWritten ?? 0) : 0;
    if (count < wanted) count = Math.max(count, await writeEngineStorage(profile, origin, change, stillCurrent));
    if (count >= wanted) landed.add(origin);
    stored += count;
  }
  return { cookies: reply.cookiesWritten ?? 0, removed: reply.removed ?? 0, storage: stored, landed };
}

export async function readChromiumStorageWithoutPage(profile: string, origins: string[]): Promise<SiteStorage> {
  const storage: SiteStorage = {};
  await Promise.all(origins.map(async (o) => void (storage[o] = await chromiumStorage(profile, o, []))));
  return storage;
}

export async function writeChromiumStorageWithoutPage(profile: string, storage: Record<string, StorageChange>, stillCurrent: () => boolean): Promise<{ storage: number; landed: Set<string> }> {
  const landed = new Set<string>();
  let stored = 0;
  for (const [origin, change] of Object.entries(storage)) {
    if (!stillCurrent()) break;
    const count = await writeEngineStorage(profile, origin, change, stillCurrent);
    if (count >= change.set.length + change.remove.length) landed.add(origin);
    stored += count;
  }
  return { storage: stored, landed };
}

export async function writeWebKit(profile: string, cookies: PageCookie[], remove: CookieRemoval[], storage: Record<string, StorageChange>): Promise<Written | null> {
  const reply = await writeWebKitSiteData(profile, cookies, remove, storage).catch(() => null);
  if (!reply) return null;
  const wanted = Object.values(storage).reduce((n, c) => n + c.set.length + c.remove.length, 0);
  return { ...reply, landed: new Set(reply.storage >= wanted ? Object.keys(storage) : []) };
}
