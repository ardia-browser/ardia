import type { DrmDiagnostic } from "../../platform/tabs";
import { PROTECTED_VIDEO_SITES } from "../engines/engines";
import { capture } from "./client";
import { onConsentPeriodChange, stillValid, type ConsentToken } from "./choice";

const MAX_EVENTS = 30;
const MAX_BLOCKED_HOSTS = 8;
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,98}[a-z0-9])?$/;
const PROBLEM_STAGES = new Set(["accessDenied", "waitingforkey", "error"]);
const FAMILIES = [
  ["widevine", "com.widevine.alpha"],
  ["playready", "com.microsoft.playready"],
  ["fairplay", "com.apple.fps"],
] as const;

let sent = 0;
const seen = new Set<string>();

onConsentPeriodChange(() => {
  sent = 0;
  seen.clear();
});

const hostname = (value: unknown) => (typeof value === "string" && HOSTNAME.test(value) ? value : null);

const builtInSite = (host: string) => PROTECTED_VIDEO_SITES.find((domain) => host === domain || host.endsWith(`.${domain}`));

const family = (keySystem: unknown) => {
  if (typeof keySystem !== "string" || keySystem === "") return "none";
  return FAMILIES.find(([, prefix]) => keySystem.startsWith(prefix))?.[0] ?? "other";
};

export function trackDrmDiagnostic(report: DrmDiagnostic, consent: ConsentToken | null) {
  if (!stillValid(consent)) return;
  if (!PROBLEM_STAGES.has(report.stage)) return;
  const host = hostname(report.host);
  const site = host && builtInSite(host);
  if (!site) return;
  const systemFamily = family(report.keySystem);
  const stage = report.stage;
  const code = Number.isSafeInteger(report.code) ? report.code : 0;
  const blockedHosts = (Array.isArray(report.blockedHosts) ? report.blockedHosts : [])
    .map(hostname)
    .filter((value): value is string => value !== null)
    .slice(0, MAX_BLOCKED_HOSTS);
  const main = report.main === true;
  const key = `${site}|${systemFamily}|${stage}|${code}|${main}|${blockedHosts.length}`;
  if (seen.has(key) || sent >= MAX_EVENTS) return;
  seen.add(key);
  sent++;
  capture(
    "protected_media",
    { site: site.replaceAll(".", "_"), family: systemFamily, stage, code, main, blocked_hosts_n: blockedHosts.length },
    consent,
  );
}
