import type { PluginRecord } from "./store";
import { ownValue } from "../../lib/decode";

export const RETIRED_OFFICIAL_PLUGINS: Readonly<Record<string, readonly string[]>> = {
  "apple-passwords": ["d8476938b3d33c28cb5494dd4fe670accce05a3f61b1d458c737a8f43505824e"],
};
const retiredThisLaunch = new Map<string, PluginRecord>();

export const retiredRecordOf = (name: string): PluginRecord | undefined => retiredThisLaunch.get(name);

const retiredApprovals = (name: string): readonly string[] => (Object.hasOwn(RETIRED_OFFICIAL_PLUGINS, name) ? RETIRED_OFFICIAL_PLUGINS[name]! : []);

export const isBundledRetiredRecord = (name: string, record: PluginRecord | undefined) => !!record?.approved && retiredApprovals(name).includes(record.approved);

export function noteRetiredRecords(before: Record<string, PluginRecord>, after: Record<string, PluginRecord>) {
  for (const name of Object.keys(RETIRED_OFFICIAL_PLUGINS)) {
    const record = ownValue(before, name);
    if (isBundledRetiredRecord(name, record) && !isBundledRetiredRecord(name, ownValue(after, name))) retiredThisLaunch.set(name, record!);
  }
}
