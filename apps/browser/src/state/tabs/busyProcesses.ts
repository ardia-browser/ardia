import { canonicalIpv6, urlParts } from "../../lib/urlParts";
import type { ChildProcessCpu } from "../../platform/performance";

type Reading = { at: number; cpuMs: number };

export type ProcessHeat = { started: number; readings: Reading[]; cores: number; busySince: number | null };

export const BUSY_TICK_MS = 10_000;
export const HOT_CORES = 0.7;
export const SUSTAINED_MS = 120_000;
const LONGEST_GAP_MS = 2.5 * BUSY_TICK_MS;

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

export function validReadings(raw: unknown): ChildProcessCpu[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const valid: ChildProcessCpu[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { pid, started, cpuMs } = r as Record<string, unknown>;
    if (!isCount(pid) || !Number.isInteger(pid) || pid <= 0 || seen.has(pid) || !isCount(started) || !isCount(cpuMs)) continue;
    seen.add(pid);
    valid.push({ pid, started, cpuMs });
  }
  return valid;
}

function cpuAt(window: readonly Reading[], at: number): number | null {
  const before = window[0]!;
  if (before.at > at) return null;
  const after = window.find((r) => r.at >= at);
  if (!after || after === before) return before.cpuMs;
  return before.cpuMs + ((after.cpuMs - before.cpuMs) * (at - before.at)) / (after.at - before.at);
}

export function readHeat(prev: ReadonlyMap<number, ProcessHeat>, readings: readonly ChildProcessCpu[], now: number, hotCores = HOT_CORES): Map<number, ProcessHeat> {
  const next = new Map<number, ProcessHeat>();
  for (const r of readings) {
    const was = prev.get(r.pid);
    const last = was?.readings[was.readings.length - 1];
    const continued = !!was && !!last && was.started === r.started && now > last.at && now - last.at <= LONGEST_GAP_MS && r.cpuMs >= last.cpuMs;
    const kept = continued ? was.readings : [];
    let from = 0;
    while (from + 1 < kept.length && kept[from + 1]!.at <= now - SUSTAINED_MS) from++;
    const window = [...kept.slice(from), { at: now, cpuMs: r.cpuMs }];
    const cores = continued ? (r.cpuMs - last.cpuMs) / (now - last.at) : 0;
    const atCutoff = cpuAt(window, now - SUSTAINED_MS);
    const busy = atCutoff !== null && (r.cpuMs - atCutoff) / SUSTAINED_MS >= hotCores;
    next.set(r.pid, { started: r.started, readings: window, cores, busySince: busy ? (was?.busySince ?? now) : null });
  }
  return next;
}

export function sustainedBusy(heat: ReadonlyMap<number, ProcessHeat>): number[] {
  const pids: number[] = [];
  for (const [pid, h] of heat) if (h.busySince !== null) pids.push(pid);
  return pids;
}

const webParts = (address: string) => {
  const parts = urlParts(address);
  return parts && (parts.scheme === "http" || parts.scheme === "https") ? { scheme: parts.scheme, host: parts.host.replace(/\.$/, "") } : null;
};

const webHost = (address: string) => webParts(address)?.host ?? null;

const HOST_RULE = /^(?:(https?):\/\/)?(?:(\[[0-9a-f:]+\])|(\.?)([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)\.?)\/?$/;

export function keptActive(address: string, rules: readonly unknown[]): boolean {
  const page = webParts(address);
  if (!page) return false;
  return rules.some((rule) => {
    const m = typeof rule === "string" ? HOST_RULE.exec(rule.trim().toLowerCase()) : null;
    if (!m) return false;
    const [, scheme, literal, exact, kept = ""] = m;
    if (scheme && scheme !== page.scheme) return false;
    if (literal) return canonicalIpv6(literal.slice(1, -1)) === literal.slice(1, -1) && page.host === literal;
    return page.host === kept || (!exact && page.host.endsWith(`.${kept}`));
  });
}

export function siteToKeepActive(address: string): string | null {
  return webHost(address)?.replace(/^www\./, "") || null;
}
