import { isTestInstance, testInstanceValue } from "../../platform/launchConfig";
import { currentPlugins, recordOf } from "./store";
import { afterPluginScan } from "./scanListeners";
import { enablePlugin, requestPluginConsent } from "./lifecycle";

export const testApprovedNames = (value: string | null): Set<string> => new Set((value ?? "").split(/[\s,]+/).filter((name) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(name)));

export function approveForTests(names: ReadonlySet<string>): string[] {
  const approved: string[] = [];
  for (const name of names) {
    const s = currentPlugins();
    const listing = s.listings[name];
    if (!listing?.manifest || !listing.hash || listing.official || listing.legacy || listing.problems.length) continue;
    const record = recordOf(s, name);
    if (record.enabled && record.approved === listing.hash) continue;
    if (s.consent && s.consent.name !== name) continue;
    if (!s.consent && !requestPluginConsent(name)) continue;
    if (enablePlugin(name, listing.hash)) approved.push(name);
  }
  return approved;
}

let watching = false;

export function watchTestApprovals() {
  if (watching || !isTestInstance()) return;
  const names = testApprovedNames(testInstanceValue("pluginApprove"));
  if (!names.size) return;
  watching = true;
  afterPluginScan(() => {
    const approved = approveForTests(names);
    if (approved.length) console.log(`[plugins] approved for this test instance: ${approved.join(", ")}`);
  });
}
