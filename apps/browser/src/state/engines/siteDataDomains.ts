import { registrableDomainsOf } from "../../platform/siteSettings";
import { withDeadline } from "../../lib/deadline";
import { bareHost, knowsRegistrableDomain, rememberRegistrableDomain } from "./siteDataMerge";

const LOOKUP_DEADLINE_MS = 400;
const RETRY_AFTER_MS = 10 * 60_000;
const ANY_PROFILE = "";
const MAX_HOSTS = 256;

const asking = new Map<string, Promise<void>>();
let unavailableUntil = 0;

function ask(hosts: string[]): Promise<void> {
  const job = registrableDomainsOf(ANY_PROFILE, hosts).then(
    ({ domains }) => {
      hosts.forEach((host, i) => {
        const domain = domains[i];
        if (typeof domain === "string") rememberRegistrableDomain(host, domain);
      });
    },
    () => void (unavailableUntil = Date.now() + RETRY_AFTER_MS),
  );
  const settled = job.finally(() => hosts.forEach((host) => asking.get(host) === settled && asking.delete(host)));
  for (const host of hosts) asking.set(host, settled);
  return settled;
}

export async function learnRegistrableDomains(hosts: readonly string[]): Promise<void> {
  const wanted = [...new Set(hosts.map(bareHost))].filter((host) => host && !knowsRegistrableDomain(host));
  if (!wanted.length || Date.now() < unavailableUntil) return;
  const fresh = wanted.filter((host) => !asking.has(host)).slice(0, MAX_HOSTS);
  if (fresh.length) void ask(fresh);
  const waits = wanted.flatMap((host) => asking.get(host) ?? []);
  await withDeadline(Promise.all(waits), LOOKUP_DEADLINE_MS, undefined);
}

export const resetRegistrableLookupsForTest = () => {
  asking.clear();
  unavailableUntil = 0;
};
