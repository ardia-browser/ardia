import { displayHost } from "@ardia/core";
import { isFields } from "../../lib/decode";
import { sourceMatches, type LinkSource } from "../../lib/linkSource";
import { globMatches, matchesUrl, parseMatchPattern, type MatchSpec } from "../../lib/matchPattern";
import { parseSaved, unchanged, versionedJson, type Migrations } from "../../lib/savedDocument";
import { urlParts } from "../../lib/urlParts";

export const AIR_TRAFFIC_DOC = "air-traffic.json";
export const AIR_TRAFFIC_VERSION = 2;
export const MAX_AIR_TRAFFIC_RULES = 100;
const MIGRATIONS: Migrations = { 0: unchanged, 1: unchanged };

export const OPEN_AS = ["tab", "window", "littleArdia"] as const;
export type OpenAs = (typeof OPEN_AS)[number];
export type SourceApp = { bundleId: string | null; name: string };
export type LinkTextKind = "contains" | "equals";
export type LinkCondition = { kind: "any" } | { kind: "site"; host: string } | { kind: "pattern"; pattern: string } | { kind: "contains"; text: string } | { kind: "equals"; text: string };
export type AirTrafficTarget = { profileId: string | null; open: OpenAs; groupKey?: string };
export type AirTrafficRule = AirTrafficTarget & { id: string; enabled: boolean; from: SourceApp | null; when: LinkCondition };
export type AirTrafficConfig = { rules: AirTrafficRule[]; fallback: AirTrafficTarget | null; fallbackChosen?: true; inAppLinks: boolean };
export type TargetUsable = (profileId: string, groupKey: string | null) => boolean;
export type AirTrafficMatch = { by: "rule"; rule: AirTrafficRule; index: number; target: AirTrafficTarget } | { by: "fallback"; target: AirTrafficTarget };

export const NO_AIR_TRAFFIC: AirTrafficConfig = { rules: [], fallback: null, inAppLinks: false };

export function siteHost(input: string): string | null {
  let text = input.trim().toLowerCase();
  if (!text) return null;
  if (text.includes("://")) {
    const parts = urlParts(text);
    if (!parts?.host) return null;
    text = parts.host;
  } else text = text.split(/[/?#]/)[0]!;
  text = text.replace(/^\*\./, "").replace(/\.$/, "");
  if (!text) return null;
  const spec = parseMatchPattern(`*://*.${text}/*`);
  return "error" in spec || !spec.host ? null : spec.host;
}

export const MAX_LINK_TEXT = 2048;

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export const linkText = (text: string) => text.trim().toLowerCase().replace(SCHEME, "").replace(/^www\./, "");

function webAddress(text: string): URL | null {
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url : null;
  } catch {
    return null;
  }
}

const pageOf = (url: URL) => {
  const port = url.port === "80" || url.port === "443" ? "" : url.port;
  return `${url.hostname.replace(/^www\./, "")}${port ? `:${port}` : ""}${url.pathname}`.toLowerCase().replace(/\/+$/, "");
};

export function exactAddress(text: string): string | null {
  const raw = text.trim();
  if (/[?#]/.test(raw)) return null;
  const url = webAddress(SCHEME.test(raw) ? raw : `http://${raw}`);
  return url && !url.username && !url.password ? pageOf(url) : null;
}

export function linkTextProblem(kind: LinkTextKind, text: string): string | null {
  const t = linkText(text);
  if (/^[\s/?#.:;,&=]*$/.test(t)) return "it matches every link; pick Any link for that";
  if (text.length > MAX_LINK_TEXT) return `keep it under ${MAX_LINK_TEXT} characters`;
  if (kind === "equals" && !exactAddress(text)) return "type a web address like example.com/docs, without ? or # (http and https only)";
  return null;
}

function textMatches(kind: LinkTextKind, text: string, url: string): boolean {
  if (kind === "contains") return linkText(url).includes(linkText(text));
  const page = webAddress(url);
  return !!page && pageOf(page) === exactAddress(text);
}

export const isWildcardPattern = (pattern: string) => pattern !== "<all_urls>" && !pattern.includes("://");

export function patternProblem(pattern: string): string | null {
  const text = pattern.trim();
  if (!text) return "type one, like *github* or https://*.example.com/docs/*";
  if (isWildcardPattern(text)) return /\s/.test(text) ? "a pattern can't have spaces" : null;
  const spec = parseMatchPattern(text);
  return "error" in spec ? spec.error : null;
}

function wildcardMatches(pattern: string, url: string): boolean {
  const parts = urlParts(url);
  if (!parts?.host) return false;
  const lower = pattern.toLowerCase();
  const glob = lower.includes("*") ? lower : `*${lower}*`;
  const hosts = new Set([parts.host, displayHost(parts.host)]);
  const rest = glob.includes("/") ? `${parts.path}${parts.query}`.toLowerCase() : "";
  return [...hosts].some((host) => globMatches(glob, `${host}${rest}`));
}

const compiled = new Map<string, MatchSpec | null>();

function specOf(pattern: string): MatchSpec | null {
  if (!compiled.has(pattern)) {
    const spec = parseMatchPattern(pattern);
    if (compiled.size > 500) compiled.clear();
    compiled.set(pattern, "error" in spec ? null : spec);
  }
  return compiled.get(pattern)!;
}

export function linkMatches(when: LinkCondition, url: string): boolean {
  if (when.kind === "any") return true;
  if (when.kind === "contains" || when.kind === "equals") return textMatches(when.kind, when.text, url);
  if (when.kind === "pattern" && isWildcardPattern(when.pattern)) return wildcardMatches(when.pattern, url);
  const spec = specOf(when.kind === "site" ? `*://*.${when.host}/*` : when.pattern);
  return !!spec && matchesUrl(spec, url);
}

export const appMatches = (from: SourceApp | null, source: LinkSource) => !from || sourceMatches([from.bundleId ?? from.name], source);

const targetUsable = (target: AirTrafficTarget, usable: TargetUsable) => target.profileId === null || usable(target.profileId, null);

const targetOf = (target: AirTrafficTarget, usable: TargetUsable): AirTrafficTarget => ({
  profileId: target.profileId,
  open: target.open,
  ...(target.groupKey && target.profileId !== null && usable(target.profileId, target.groupKey) ? { groupKey: target.groupKey } : {}),
});

export function cleanTarget(target: AirTrafficTarget): AirTrafficTarget {
  const { profileId, open, groupKey } = target;
  return groupKey && profileId !== null && open === "tab" ? { profileId, open, groupKey } : { profileId, open };
}

export const cleanRule = ({ groupKey, ...rule }: AirTrafficRule): AirTrafficRule => ({
  ...rule,
  ...cleanTarget({ profileId: rule.profileId, open: rule.open, groupKey }),
});

export const sameTarget = (a: AirTrafficTarget | null, b: AirTrafficTarget | null) =>
  a === b || (!!a && !!b && a.profileId === b.profileId && a.open === b.open && (a.groupKey ?? null) === (b.groupKey ?? null));

export function airTrafficRule(config: AirTrafficConfig, url: string, source: LinkSource, usable: TargetUsable): AirTrafficMatch | null {
  const index = config.rules.findIndex((r) => r.enabled && appMatches(r.from, source) && linkMatches(r.when, url) && targetUsable(r, usable));
  if (index < 0) return null;
  const rule = config.rules[index]!;
  return { by: "rule", rule, index, target: targetOf(rule, usable) };
}

export function airTrafficFallback(config: AirTrafficConfig, usable: TargetUsable): AirTrafficMatch | null {
  return config.fallback && targetUsable(config.fallback, usable) ? { by: "fallback", target: targetOf(config.fallback, usable) } : null;
}

export const fallbackChosen = (config: AirTrafficConfig) => !!config.fallbackChosen || config.fallback !== null;

export const airTrafficHolds = (config: AirTrafficConfig) => !!config.fallback || config.rules.some((r) => r.enabled);

const isOpenAs = (v: unknown): v is OpenAs => OPEN_AS.includes(v as OpenAs);
const isProfileRef = (v: unknown): v is string | null => v === null || (typeof v === "string" && !!v);

export function sourceAppOf(v: unknown): SourceApp | null {
  if (!isFields(v) || typeof v.name !== "string" || !v.name.trim()) return null;
  if (v.bundleId !== null && (typeof v.bundleId !== "string" || !v.bundleId.trim())) return null;
  return { bundleId: (v.bundleId as string | null) ?? null, name: v.name.trim() };
}

function conditionOf(v: unknown): LinkCondition | null {
  if (!isFields(v)) return null;
  if (v.kind === "any") return { kind: "any" };
  if (v.kind === "site" && typeof v.host === "string" && siteHost(v.host) === v.host) return { kind: "site", host: v.host };
  if (v.kind === "pattern" && typeof v.pattern === "string" && !patternProblem(v.pattern)) return { kind: "pattern", pattern: v.pattern };
  if ((v.kind === "contains" || v.kind === "equals") && typeof v.text === "string" && !linkTextProblem(v.kind, v.text)) return { kind: v.kind, text: v.text };
  return null;
}

function targetFrom(v: unknown): AirTrafficTarget | null {
  if (!isFields(v) || !isProfileRef(v.profileId) || !isOpenAs(v.open)) return null;
  const groupKey = typeof v.groupKey === "string" ? v.groupKey : undefined;
  return cleanTarget({ profileId: v.profileId, open: v.open, groupKey });
}

function ruleOf(v: unknown): AirTrafficRule | null {
  if (!isFields(v) || typeof v.id !== "string" || !v.id || typeof v.enabled !== "boolean") return null;
  const from = v.from === null ? null : sourceAppOf(v.from);
  const when = conditionOf(v.when);
  const target = targetFrom(v);
  if ((v.from !== null && !from) || !when || !target) return null;
  return { id: v.id, enabled: v.enabled, from, when, ...target };
}

export function parseAirTraffic(json: string | null | undefined): AirTrafficConfig {
  const doc = parseSaved(json, AIR_TRAFFIC_VERSION, MIGRATIONS);
  if (!doc) return NO_AIR_TRAFFIC;
  const seen = new Set<string>();
  const rules = (Array.isArray(doc.rules) ? doc.rules : [])
    .map(ruleOf)
    .filter((r): r is AirTrafficRule => !!r && !seen.has(r.id) && !!seen.add(r.id))
    .slice(0, MAX_AIR_TRAFFIC_RULES);
  const fallback = doc.fallback === null || doc.fallback === undefined ? null : targetFrom(doc.fallback);
  return { rules, fallback, inAppLinks: doc.inAppLinks === true, ...(doc.fallbackChosen === true ? { fallbackChosen: true as const } : {}) };
}

export const airTrafficJson = (config: AirTrafficConfig) =>
  versionedJson({ rules: config.rules, fallback: config.fallback, inAppLinks: config.inAppLinks, ...(config.fallbackChosen ? { fallbackChosen: true } : {}) }, AIR_TRAFFIC_VERSION);
