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
import { currentEngineProfile } from "../../../state/browser/current";
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
import { t } from "../../../lib/uiLanguage";


const SETTING_LABELS: [SiteSettingType, string][] = [
  ["popups", t(`Pop-ups and redirects`)],
  ["camera", t(`Camera`)],
  ["microphone", t(`Microphone`)],
  ["location", t(`Location`)],
  ["notifications", t(`Notifications`)],
  ["sound", t(`Sound`)],
  ["autoplay", t(`Autoplay`)],
  ["javascript", t(`JavaScript`)],
  ["images", t(`Images`)],
  ["clipboard", t(`Clipboard`)],
  ["automaticDownloads", t(`Automatic downloads`)],
  ["cookies", t(`Cookies`)],
  ["midi", t(`MIDI devices`)],
  ["windowManagement", t(`Window management`)],
  ["localFonts", t(`Fonts`)],
  ["storageAccess", t(`Embedded content`)],
  ["fileSystem", t(`File editing`)],
];

const VALUE_OPTIONS: { value: SiteSettingValue; title: string }[] = [
  { value: "default", title: t(`Default`) },
  { value: "allow", title: t(`Allow`) },
  { value: "block", title: t(`Block`) },
  { value: "ask", title: t(`Ask`) },
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
          <SectionHeader title={t(`All sites`)} description={t(`Defaults for every site. These apply in every profile.`)} />
          <Group>
            {PLATFORM_FEATURES.blocksAutoplay ? (
              <Row
                title={t(`Block autoplay on every site`)}
                description={t(`Sites you allow in Site Controls still autoplay. Chromium tabs only.`)}
              >
                <Toggle value={blockAutoplay} accessibilityLabel={t(`Block autoplay on every site`)} onChange={(v) => updateSettings({ blockAutoplayEverywhere: v })} />
              </Row>
            ) : null}
            {PLATFORM_FEATURES.answersPermissionRequests ? (
              <Row
                title={t(`Block requests to send notifications`)}
                description={t(`Sites that ask are blocked. Sites you already allowed keep sending them.`)}
              >
                <Toggle
                  value={blockNotifications}
                  accessibilityLabel={t(`Block requests to send notifications`)}
                  onChange={(v) => updateSettings({ blockNotificationRequests: v })}
                />
              </Row>
            ) : null}
          </Group>
        </>
      )}

      <SectionHeader title={t(`Sites`)} description={t(`Sites you allowed or blocked something for in this profile.`)} />
      <Group>
        {origins === undefined ? (
          <Row title=" " description=" " />
        ) : origins.length === 0 ? (
          <Row title={t(`No sites yet`)} description={t(`Sites appear here after you allow or block something for them.`)} />
        ) : (
          origins.map((origin) => <Row key={origin} icon={<Favicon url={origin} />} title={siteLabel(origin)} onPress={() => openSite(origin)} />)
        )}
      </Group>

      {zoomHosts.length > 0 && (
        <>
          <SectionHeader title={t(`Zoom levels`)} />
          <Group>
            {zoomHosts.map((host) => (
              <Row key={host} icon={<Favicon url={`https://${host}`} />} title={host} description={percent(levels[host]!)}>
                <Button title={t(`Reset`)} onPress={() => void setZoom(profile, host, 1).then(() => void reloadZooms())} />
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
        {settings && !shown.length ? <Row title={t(`Nothing to change for this site`)} /> : null}
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

      <SectionHeader title={t(`This site`)} />
      <Group>
        {zoom !== undefined ? (
          <Row title={t(`Zoom`)} description={percent(zoom)}>
            <Button title={t(`Reset`)} onPress={() => void setZoom(profile, host, 1).then(() => void reloadZooms())} />
          </Row>
        ) : null}
        <Row title={t(`Permissions`)} description={t(`Puts every permission back to its default.`)}>
          <Button title={t(`Reset Permissions`)} onPress={() => void resetSiteSettings(profile, origin).then(changed)} />
        </Row>
        <Row title={t(`Site data`)} description={status || t(`Cookies and storage this site keeps in this profile.`)}>
          <Button
            title={t(`Clear Site Data`)}
            onPress={() =>
              void clearSiteData(profile, origin)
                .catch((): ClearSiteDataResult => ({ cookies: false, storage: false }))
                .then((r) => setStatus(r.cookies === false ? t(`Site data cleared.`) : `Cleared ${r.cookies} cookie${r.cookies === 1 ? "" : "s"} and site data.`))
            }
          />
        </Row>
      </Group>
    </ProfileSubPage>
  );
}
