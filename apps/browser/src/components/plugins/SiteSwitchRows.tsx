import { SettingRow } from "../site/SiteControlsParts";
import { setSiteSwitch, useSiteSwitchRows } from "../../state/plugins/siteSwitches";

export function SiteSwitchRows({ tabId, url }: { tabId: string; url: string }) {
  const rows = useSiteSwitchRows(tabId);
  return (
    <>
      {rows.map((r) => (
        <SettingRow key={`${r.plugin}/${r.key}`} icon={r.icon} title={r.title} value={r.on ? "On" : "Off"} on={r.on} onPress={() => void setSiteSwitch(r.plugin, r.key, url, !r.on)} />
      ))}
    </>
  );
}
