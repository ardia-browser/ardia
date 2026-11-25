import type { Tab } from "../browser/types";
import { hostOf } from "@ardia/core";

type Member = Pick<Tab, "url" | "title">;

const SEPARATORS = [" / ", " | ", " - ", " — ", " – ", " · ", " • ", " :: "];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const isIpAddress = (host: string) => host[0] === "[" || (host[0]! >= "0" && host[0]! <= "9" && IPV4.test(host));

function hostLabel(host: string): string {
  if (isIpAddress(host)) return host;
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  const second = parts.at(-2)!;
  return parts.length > 2 && second.length <= 3 && parts.at(-1)!.length <= 2 ? parts.at(-3)! : second;
}

const tidyHost = (host: string) => {
  const label = hostLabel(host);
  return label ? label[0]!.toUpperCase() + label.slice(1) : "";
};

const hostByMember = new WeakMap<Member, { url: string; host: string }>();

function memberHost(m: Member): string {
  const known = hostByMember.get(m);
  if (known && known.url === m.url) return known.host;
  const host = hostOf(m.url);
  hostByMember.set(m, { url: m.url, host });
  return host;
}

const isWideSpace = (c: string) =>
  c === " " || c === " " || (c >= " " && c <= " ") || c === " " || c === " " || c === " " || c === " " || c === "　" || c === "﻿";

const isTrimSpace = (c: string) => c === " " || (c >= "\t" && c <= "\r") || (c >= " " && isWideSpace(c));

function textStart(t: string, from = 0): number {
  let i = from;
  while (i < t.length && isTrimSpace(t[i]!)) i++;
  return i;
}

function textEnd(t: string, to = t.length): number {
  let i = to;
  while (i > 0 && isTrimSpace(t[i - 1]!)) i--;
  return i;
}

function occursAt(t: string, at: number, part: string): boolean {
  if (at < 0 || at + part.length > t.length) return false;
  for (let i = 0; i < part.length; i++) if (t[at + i] !== part[i]) return false;
  return true;
}

function occursIn(t: string, part: string, from: number, to: number): boolean {
  for (let at = from; at <= to; at++) if (occursAt(t, at, part)) return true;
  return false;
}

type Cut = { pageFrom: number; pageTo: number };

function siteCut(title: string, site: string): Cut | undefined {
  if (!site || isTrimSpace(site[0]!) || isTrimSpace(site[site.length - 1]!)) return undefined;
  const start = textStart(title);
  const end = textEnd(title);
  const siteFrom = end - site.length;
  const siteLast = siteFrom >= start && occursAt(title, siteFrom, site);
  const siteFirst = start + site.length <= end && occursAt(title, start, site);
  if (!siteLast && !siteFirst) return undefined;
  const gapBefore = siteLast ? textEnd(title, siteFrom) : 0;
  const gapAfter = siteFirst ? textStart(title, start + site.length) : 0;
  for (const sep of SEPARATORS) {
    if (siteLast && occursIn(title, sep, gapBefore - sep.length, siteFrom - sep.length)) {
      const last = title.lastIndexOf(sep);
      if (last + sep.length >= gapBefore && last + sep.length <= siteFrom && start < last) return { pageFrom: 0, pageTo: last };
    }
    if (siteFirst && occursIn(title, sep, start + site.length, gapAfter)) {
      const first = title.indexOf(sep);
      if (first >= start + site.length && first <= gapAfter && end > first + sep.length) return { pageFrom: first + sep.length, pageTo: title.length };
    }
  }
  return undefined;
}

function ends(title: string): [string, string][] {
  const out: [string, string][] = [];
  for (const sep of SEPARATORS) {
    const last = title.lastIndexOf(sep);
    if (last > 0) out.push([title.slice(last + sep.length).trim(), title.slice(0, last).trim()]);
    const first = title.indexOf(sep);
    if (first > 0) out.push([title.slice(0, first).trim(), title.slice(first + sep.length).trim()]);
  }
  return out.filter(([site, page]) => site && page);
}

function siteFromTitles(host: string, titles: string[]): string | undefined {
  const label = squash(hostLabel(host));
  const looksLikeHost = (site: string) => {
    const s = squash(site);
    return !!s && !!label && (s === label || (s.length >= 3 && (label.includes(s) || s.includes(label))));
  };
  const inEveryTitle = (site: string) => {
    for (let i = 1; i < titles.length; i++) if (!siteCut(titles[i]!, site)) return false;
    return true;
  };
  const candidates = ends(titles[0]!);
  const ruledOut: boolean[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const site = candidates[i]![0];
    if (site.split(" ").length > 3 || !looksLikeHost(site)) continue;
    if (inEveryTitle(site)) return site;
    ruledOut[i] = true;
  }
  if (titles.length < 2) return undefined;
  for (let i = 0; i < candidates.length; i++) if (!ruledOut[i] && inEveryTitle(candidates[i]![0])) return candidates[i]![0];
  return undefined;
}

export const siteKey = (url: string) => hostLabel(hostOf(url)).toLowerCase();

export function siteName(members: Member[]): string {
  let host = "";
  for (const m of members) if ((host = memberHost(m))) break;
  const titles = members.flatMap((m) => (m.title && m.title !== m.url ? [m.title] : []));
  const label = squash(hostLabel(host));
  const titledLikeHost = label ? titles.find((t) => squash(t) === label)?.trim() : undefined;
  return (titles.length ? siteFromTitles(host, titles) : undefined) ?? titledLikeHost ?? tidyHost(host);
}

function pageOf(title: string, site: string): string {
  const cut = siteCut(title, site);
  return cut ? title.slice(cut.pageFrom, cut.pageTo).trim() : title.trim();
}

const isLoaded = (m: Member) => !!m.title && m.title !== m.url;

const siteOfHost = (host: string, titles: string[]) => (titles.length ? siteFromTitles(host, titles) : undefined) ?? tidyHost(host);

function loadedByUrl(members: Member[]): Map<string, Member> {
  const byUrl = new Map<string, Member>();
  for (const m of members) if (isLoaded(m) && !byUrl.has(m.url)) byUrl.set(m.url, m);
  return byUrl;
}

export function autoGroupName(members: Member[]): string {
  if (!members.length) return "";
  const titledByHost = new Map<string, string[]>();
  for (const m of members) {
    const host = memberHost(m);
    let titles = titledByHost.get(host);
    if (!titles) titledByHost.set(host, (titles = []));
    if (isLoaded(m)) titles.push(m.title);
  }
  let site: string | undefined;
  for (const [host, titles] of titledByHost) {
    const hostSite = siteOfHost(host, titles);
    if (site === undefined) {
      site = hostSite;
      if (!site) return members[0]!.title ?? "";
    } else if (hostSite !== site) return site;
  }
  if (!site || !members.some((m) => m.title && siteCut(m.title, site!))) return site!;
  let byUrl: Map<string, Member> | undefined;
  let page: string | undefined;
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!;
    const loaded = isLoaded(m) ? m : (byUrl ??= loadedByUrl(members)).get(m.url);
    const memberPage = loaded ? pageOf(loaded.title, site) : undefined;
    if (i === 0) {
      if (!memberPage) return site;
      page = memberPage;
    } else if (memberPage !== page) return site;
  }
  return squash(page!) === squash(site) ? site : `${site} ${page}`;
}
