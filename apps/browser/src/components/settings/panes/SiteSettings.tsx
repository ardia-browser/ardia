import {
  clearSiteData,
  getSiteSettings,
  resetSiteSettings,
  setSiteSetting,
  setZoom,
  type ClearSiteDataResult,
  type SiteSettings,
  type SiteSettingType,
  type SiteSettingValue,
} from "../../../state/site/siteSettings";
import { useEffect, useState } from "react";
import { profileEngine as currentEngineProfile } from "../../../state/profiles/current";
import { useSettings } from "../../../state/browser/hooks";
import { effectiveSettingValue, offersSiteSetting } from "../../../state/site/siteControls";
import { Button, PopUp, Toggle } from "../../ui";
import { Favicon } from "../../favicon/Favicon";
import { Group, Row, SectionHeader } from "../Form";
import { siteOrigins, zoomLevels } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { goToSettingsPane, SETTINGS_DETAIL } from "../../../state/settings/settingsWindows";
import { updateSettings } from "../../../state/settings/actions";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { setting } from "../settingsIndex";
import { ProfileSubPage } from "./ProfileSubPage";

const SETTING_LABELS: [SiteSettingType, string][] = [
  ["popups", "Pop-ups and redirects"],
  ["camera", "Camera"],
  ["microphone", "Microphone"],
  ["location", "Location"],
  ["notifications", "Notifications"],
  ["sound", "Sound"],
  ["autoplay", "Autoplay"],
  ["javascript", "JavaScript"],
  ["images", "Images"],
  ["clipboard", "Clipboard"],
  ["automaticDownloads", "Automatic downloads"],
  ["cookies", "Cookies"],
  ["midi", "MIDI devices"],
  ["windowManagement", "Window management"],
  ["localFonts", "Fonts"],
  ["storageAccess", "Embedded content"],
  ["fileSystem", "File editing"],
];

const VALUE_OPTIONS: { value: SiteSettingValue; title: string }[] = [
  { value: "default", title: "Default" },
  { value: "allow", title: "Allow" },
  { value: "block", title: "Block" },
  { value: "ask", title: "Ask" },
];

const siteLabel = (origin: string) => origin.replace(/^https?:\/\//, "");
const percent = (level: number) => `${Math.round(level * 100)}%`;

export function SitesPage({ profileId }: { profileId: string }) {
  const profile = currentEngineProfile(profileId);
  const blockAutoplay = useSettings((s) => s.blockAutoplayEverywhere);
  const blockNotifications = useSettings((s) => s.blockNotificationRequests);
  const [origins] = useResource(siteOrigins, profile);
  const [zooms, reloadZooms] = useResource(zoomLevels, profile);
  const levels = zooms ?? {};
  const zoomHosts = Object.keys(levels).sort();
  const openSite = (origin: string) => goToSettingsPane("profiles", profileId, SETTINGS_DETAIL.site(origin));

  return (
    <ProfileSubPage>
      {(PLATFORM_FEATURES.blocksAutoplay || PLATFORM_FEATURES.answersPermissionRequests) && (
        <>
          <SectionHeader title="All sites" description="Defaults for every site. These apply in every profile." />
          <Group>
            {PLATFORM_FEATURES.blocksAutoplay ? (
              <Row
                title="Block autoplay on every site"
                description="Sites you allow in Site Controls still autoplay. Chromium tabs only."
              >
                <Toggle value={blockAutoplay} accessibilityLabel="Block autoplay on every site" onChange={(v) => updateSettings({ blockAutoplayEverywhere: v })} />
              </Row>
            ) : null}
            {PLATFORM_FEATURES.answersPermissionRequests ? (
              <Row
                title="Block requests to send notifications"
                description="Sites that ask are blocked. Sites you already allowed keep sending them."
              >
                <Toggle
                  value={blockNotifications}
                  accessibilityLabel="Block requests to send notifications"
                  onChange={(v) => updateSettings({ blockNotificationRequests: v })}
                />
              </Row>
            ) : null}
          </Group>
        </>
      )}

      <SectionHeader title="Sites" description="Sites you allowed or blocked something for in this profile." />
      <Group>
        {origins === undefined ? (
          <Row title=" " description=" " />
        ) : origins.length === 0 ? (
          <Row title="No sites yet" description="Sites appear here after you allow or block something for them." />
        ) : (
          origins.map((origin) => <Row key={origin} icon={<Favicon url={origin} />} title={siteLabel(origin)} onPress={() => openSite(origin)} />)
        )}
      </Group>

      {zoomHosts.length > 0 && (
        <>
          <SectionHeader title="Zoom levels" />
          <Group>
            {zoomHosts.map((host) => (
              <Row key={host} icon={<Favicon url={`https://${host}`} />} title={host} description={percent(levels[host]!)}>
                <Button title="Reset" onPress={() => void setZoom(profile, host, 1).then(() => void reloadZooms())} />
              </Row>
            ))}
          </Group>
        </>
      )}
    </ProfileSubPage>
  );
}

export function SitePage({ profileId, origin }: { profileId: string; origin: string }) {
  const profile = currentEngineProfile(profileId);
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [status, setStatus] = useState("");
  const [, reloadOrigins] = useResource(siteOrigins, profile);
  const [zooms, reloadZooms] = useResource(zoomLevels, profile);
  useSettings((s) => s.blockAutoplayEverywhere);
  const host = siteLabel(origin);
  const zoom = zooms?.[host];
  const load = () => void getSiteSettings(profile, origin).catch((): SiteSettings => ({}) as SiteSettings).then(setSettings).catch(() => {});
  useEffect(load, [profile, origin]);
  const changed = () => {
    load();
    void reloadOrigins();
  };
  const set = async (type: SiteSettingType, value: SiteSettingValue) => {
    await setSiteSetting(profile, origin, type, value);
    changed();
  };
  const shown = SETTING_LABELS.filter(([type]) => settings?.[type] && offersSiteSetting(type));

  return (
    <ProfileSubPage>
      <SectionHeader title={host} description={null} action={<Favicon url={origin} size={20} />} />
      <Group>
        {settings && !shown.length ? <Row title="Nothing to change for this site" /> : null}
        {shown.map(([type, label]) => (
          <Row key={type} title={label} description={settings![type].isDefault ? `Default (${effectiveSettingValue(type, settings!)})` : undefined}>
            <PopUp
              value={settings![type].isDefault ? "default" : settings![type].value}
              options={VALUE_OPTIONS}
              onChange={(v) => void set(type, v)}
              minWidth={100}
            />
          </Row>
        ))}
      </Group>

      <SectionHeader title="This site" />
      <Group>
        {zoom !== undefined ? (
          <Row title="Zoom" description={percent(zoom)}>
            <Button title="Reset" onPress={() => void setZoom(profile, host, 1).then(() => void reloadZooms())} />
          </Row>
        ) : null}
        <Row title="Permissions" description="Puts every permission back to its default.">
          <Button title="Reset Permissions" onPress={() => void resetSiteSettings(profile, origin).then(changed)} />
        </Row>
        <Row title="Site data" description={status || "Cookies and storage this site keeps in this profile."}>
          <Button
            title="Clear Site Data"
            onPress={() =>
              void clearSiteData(profile, origin)
                .catch((): ClearSiteDataResult => ({ cookies: false, storage: false }))
                .then((r) => setStatus(r.cookies === false ? "Site data cleared." : `Cleared ${r.cookies} cookie${r.cookies === 1 ? "" : "s"} and site data.`))
            }
          />
        </Row>
      </Group>
    </ProfileSubPage>
  );
}
