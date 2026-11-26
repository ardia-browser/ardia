import { SettingRow } from "../site/SiteControlsParts";
import { setSiteSwitch, useSiteSwitchRows } from "../../state/plugins/siteSwitches";
import { setPluginScriptsBlocked } from "../../state/plugins/actions";
import { usePluginsTouchPages, useSitePluginScripts } from "../../state/plugins/hooks";
import { consentNow } from "../../state/telemetry/choice";

export function SiteSwitchRows({ tabId, url }: { tabId: string; url: string }) {
  const rows = useSiteSwitchRows(tabId);
  const scripts = useSitePluginScripts(tabId);
  const touchesPages = usePluginsTouchPages();
  return (
    <>
      {rows.map((r) => (
        <SettingRow key={`${r.plugin}/${r.key}`} icon={r.icon} title={r.title} value={r.on ? "On" : "Off"} on={r.on} onPress={() => void setSiteSwitch(r.plugin, r.key, url, !r.on, consentNow())} />
      ))}
      {touchesPages && scripts.origin ? (
        <SettingRow
          icon="puzzlepiece.extension"
          title="Plugin scripts"
          value={scripts.blocked ? "Off on this site" : "On"}
          on={!scripts.blocked}
          onPress={() => void setPluginScriptsBlocked(url, !scripts.blocked, consentNow())}
        />
      ) : null}
    </>
  );
}
