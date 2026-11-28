import { hostOf, punycodeEncode } from "@ardia/core";
import { canonicalIpv6 } from "../../lib/urlParts";
import type { Credential } from "../../platform/importModule";
import type { ConsentToken } from "../telemetry/choice";
import { originOfLogin } from "../site/savedPasswords";

export type CollectedLogin = { browserId: string; profileId: string; credential: Credential; consent: ConsentToken | null };
export type LoginToSave = { browserId: string; profileId: string; origin: string; username: string; password: string; consent: ConsentToken | null };
export type ConflictVersion = { browserId: string; at: number };
export type PasswordConflict = { id: string; profileId: string; store: string; profileIds: string[]; origin: string; site: string; username: string; versions: ConflictVersion[] };
export type ConflictChoices = Readonly<Record<string, string>>;
export type ConflictPick = "newest" | "custom" | (string & {});

export type LoginPlan = {
  clean: LoginToSave[];
  conflicts: PasswordConflict[];
  versions: ReadonlyMap<string, ReadonlyMap<string, LoginToSave>>;
  merged: number;
};

export const loginOrigin = (c: Credential) => originOfLogin(c.realm?.startsWith("http") ? c.realm : c.url);
const DEFAULT_PORTS: Readonly<Record<string, number>> = { http: 80, https: 443, ftp: 21, ws: 80, wss: 443 };
const ORIGIN_PARTS = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]*\]|[^:/?#]*)(?::(\d+))?(?=$|[/?#])/i;

const asciiLabel = (label: string) => (/^[\x00-\x7f]*$/.test(label) ? label : `xn--${punycodeEncode(label)}`);
const IDEOGRAPHIC_DOTS = /[\u3002\uff0e\uff61]/g;
const asciiHost = (host: string) => host.normalize("NFKC").toLowerCase().replace(IDEOGRAPHIC_DOTS, ".").split(".").map(asciiLabel).join(".");

export function sameOriginKey(origin: string): string {
  const found = ORIGIN_PARTS.exec(origin.trim());
  if (!found) return origin.trim().toLowerCase();
  const scheme = found[1]!.toLowerCase();
  const rawHost = found[2]!;
  const inner = rawHost.slice(1, -1).toLowerCase();
  const host = rawHost.startsWith("[") ? `[${canonicalIpv6(inner) ?? inner}]` : asciiHost(rawHost);
  const port = found[3] === undefined ? null : Number(found[3]);
  const shown = port === null || port === DEFAULT_PORTS[scheme] ? "" : `:${port}`;
  return `${scheme}://${host}${shown}`;
}

export type ProfileName = { id: string; name: string; icon?: string | null };

export function profileLabels(ids: readonly string[], profiles: readonly ProfileName[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const id of ids) {
    const own = profiles.find((p) => p.id === id);
    if (!own) {
      labels[id] = "another profile";
      continue;
    }
    const namesakes = profiles.filter((p) => p.name.trim().toLowerCase() === own.name.trim().toLowerCase());
    const iconsDiffer = namesakes.filter((p) => (p.icon ?? "") === (own.icon ?? "")).length === 1 && !!own.icon;
    labels[id] = namesakes.length < 2 ? own.name : iconsDiffer ? `${own.icon} ${own.name}` : `${own.name} (${namesakes.indexOf(own) + 1})`;
  }
  return labels;
}

export const loginAge = (c: Pick<Credential, "created" | "lastUsed">) => Math.max(c.lastUsed ?? 0, c.created ?? 0);

type Held = { login: LoginToSave; at: number };

export function planLogins(collected: readonly CollectedLogin[], order: readonly string[], storeOf: (profileId: string) => string = (profileId) => profileId): LoginPlan {
  const groups = new Map<string, Map<string, Held>>();
  for (const { browserId, profileId, credential, consent } of collected) {
    const origin = loginOrigin(credential);
    if (!origin || !credential.password) continue;
    const key = JSON.stringify([storeOf(profileId), sameOriginKey(origin), credential.username]);
    const byBrowser = groups.get(key) ?? new Map<string, Held>();
    const at = loginAge(credential);
    const earlier = byBrowser.get(browserId);
    if (!earlier || at >= earlier.at) byBrowser.set(browserId, { login: { browserId, profileId, origin, username: credential.username, password: credential.password, consent }, at });
    groups.set(key, byBrowser);
  }
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  const clean: LoginToSave[] = [];
  const conflicts: PasswordConflict[] = [];
  const versions = new Map<string, ReadonlyMap<string, LoginToSave>>();
  let merged = 0;
  for (const byBrowser of groups.values()) {
    const held = [...byBrowser.values()].sort((a, b) => rank(a.login.browserId) - rank(b.login.browserId));
    const first = held[0]!;
    if (held.every((h) => h.login.password === first.login.password)) {
      clean.push(first.login);
      merged += held.length - 1;
      continue;
    }
    const id = `conflict-${conflicts.length}`;
    const { profileId, username } = first.login;
    const origin = sameOriginKey(first.login.origin);
    const profileIds = [...new Set(held.map((h) => h.login.profileId))];
    const versionsOf = held.map((h) => ({ browserId: h.login.browserId, at: h.at }));
    conflicts.push({ id, profileId, store: storeOf(profileId), profileIds, origin, site: hostOf(origin) || origin, username, versions: versionsOf });
    versions.set(id, new Map(held.map((h) => [h.login.browserId, h.login])));
  }
  return { clean, conflicts, versions, merged };
}

export const newestVersion = (conflict: PasswordConflict) => conflict.versions.reduce((best, v) => (v.at > best.at ? v : best)).browserId;

export function choicesFor(conflicts: readonly PasswordConflict[], pick: string): Record<string, string> {
  return Object.fromEntries(conflicts.map((c) => [c.id, c.versions.some((v) => v.browserId === pick) ? pick : newestVersion(c)]));
}

export function conflictBrowsers(conflicts: readonly PasswordConflict[], order: readonly string[]): string[] {
  const involved = new Set(conflicts.flatMap((c) => c.versions.map((v) => v.browserId)));
  return order.filter((id) => involved.has(id));
}

export function newerCounts(conflicts: readonly PasswordConflict[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of conflicts) {
    if (c.versions.every((v) => v.at === c.versions[0]!.at)) continue;
    const id = newestVersion(c);
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

export const changedChoices = (from: ConflictChoices, to: ConflictChoices) => Object.keys(to).filter((id) => from[id] !== to[id]).length;

export function matchingConflicts(conflicts: readonly PasswordConflict[], filter: string): PasswordConflict[] {
  const text = filter.trim().toLowerCase();
  if (!text) return [...conflicts];
  return conflicts.filter((c) => c.origin.toLowerCase().includes(text) || c.username.toLowerCase().includes(text));
}

export type ConflictRow = { conflict: PasswordConflict; title: string; showsProfile: boolean };

export function conflictRows(conflicts: readonly PasswordConflict[]): ConflictRow[] {
  const showsProfile = new Set(conflicts.map((c) => c.store)).size > 1 || conflicts.some((c) => c.profileIds.length > 1);
  const reads = (c: PasswordConflict) => JSON.stringify([c.site, c.username, showsProfile ? c.store : ""]);
  const seen = new Map<string, number>();
  for (const c of conflicts) seen.set(reads(c), (seen.get(reads(c)) ?? 0) + 1);
  return conflicts.map((conflict) => ({ conflict, title: seen.get(reads(conflict))! > 1 ? conflict.origin : conflict.site, showsProfile }));
}

export function resolvedLogins(plan: LoginPlan, choices: ConflictChoices): LoginToSave[] {
  return [
    ...plan.clean,
    ...plan.conflicts.map((c) => {
      const byBrowser = plan.versions.get(c.id)!;
      return byBrowser.get(choices[c.id] ?? "") ?? byBrowser.get(newestVersion(c))!;
    }),
  ];
}

export type ConflictResolution = "newest" | "browser" | "custom";

export const resolutionOf = (pick: ConflictPick): ConflictResolution => (pick === "newest" ? "newest" : pick === "custom" ? "custom" : "browser");
