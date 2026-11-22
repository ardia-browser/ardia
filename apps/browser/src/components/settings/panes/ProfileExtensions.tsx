import {
  addFromWebStore,
  configure,
  loadUnpacked,
  openExtensionDetails,
  openInExtensionProfile,
  openWebStoreFor,
  reload,
  removeExtension,
  setEnabled,
  setPinned,
} from "../../../state/extensions/actions";
import { useExtensionList, type InstalledExtension } from "../../../state/extensions/store";
import { useEffect } from "react";
import { Image, View } from "react-native";
import { currentEngineProfile } from "../../../state/browser/current";
import { InstallDialogHost } from "../../extensions/ExtensionOverlays";
import { Box, Button, PopUp, proseLineHeight, space, Text, Toggle } from "../../ui";
import { Group, Row, SectionHeader } from "../Form";
import { extensionList } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { replaceSettingsPlace, SETTINGS_WINDOW_ID } from "../../../state/settings/settingsWindows";
import { prompt, showMenu } from "../../../state/app/system";
import { perLook } from "../../ui/tokens";
import { useProfile } from "../../../state/browser/hooks";
import { ProfileSubPage } from "./ProfileSubPage";
import { t } from "../../../lib/uiLanguage";


type SiteAccess = "allSites" | "specificSites" | "onClick";
const SITE_ACCESS: { value: SiteAccess; title: string }[] = [
  { value: "allSites", title: t(`On all sites`) },
  { value: "specificSites", title: t(`On specific sites`) },
  { value: "onClick", title: t(`On click`) },
];
const siteAccessOf = (ext: InstalledExtension): SiteAccess =>
  ext.siteAccess === "ON_CLICK" ? "onClick" : ext.siteAccess === "ON_SPECIFIC_SITES" ? "specificSites" : "allSites";

const showInstall = () => showSettingsSheet(<InstallDialogHost windowId={SETTINGS_WINDOW_ID} onClosed={closeSettingsSheet} />);

async function addFromLink(profile: string) {
  const link = await prompt({
    title: t(`Add Extension from a Link`),
    message: t(`Paste a Chrome Web Store link or extension ID.`),
    placeholder: "chromewebstore.google.com/detail/…",
    confirmTitle: t(`Add`),
  });
  if (!link?.trim()) return;
  void addFromWebStore(SETTINGS_WINDOW_ID, link.trim(), profile);
  showInstall();
}

async function openMoreMenu(profile: string) {
  const choice = await showMenu([
    { id: "link", title: t(`Add from a Link…`), symbol: "link" },
    { id: "unpacked", title: t(`Load Unpacked Extension…`), symbol: "folder" },
  ]);
  if (choice === "link") void addFromLink(profile);
  else if (choice === "unpacked") void loadUnpacked(SETTINGS_WINDOW_ID, profile).then((chosen) => chosen && showInstall());
}

export function ExtensionsSection({ profileId }: { profileId: string }) {
  const profile = currentEngineProfile(profileId);
  const list = useExtensionList(profile);
  useResource(extensionList, profile);

  return (
    <>
      <SectionHeader
        title={t(`Extensions`)}
        action={<Button variant="icon" icon="ellipsis" size="m" tooltip={t(`More`)} onPress={() => void openMoreMenu(profile)} />}
      />
      <Group>
        <Row anchor="profiles.extensions" description={list.length ? undefined : t(`Extensions you add appear here and in the Extensions menu. Each profile has its own.`)} />
        {list.map((ext) => (
          <Row
            key={ext.id}
            icon={<Image source={{ uri: ext.icon }} style={{ width: 24, height: 24, opacity: ext.enabled ? 1 : 0.5 }} />}
            title={
              <Text lines={1}>
                {ext.name}
                <Text tone="textTertiary">{`  ${ext.version}${ext.fromWebStore ? "" : " · Developer"}`}</Text>
              </Text>
            }
            description={ext.errors.length && !ext.enabled ? ext.errors[0] : ext.description}
            onPress={() => openExtensionDetails(profileId, ext.id)}
          >
            <Toggle value={ext.enabled} onChange={(on) => void setEnabled(profile, ext.id, on)} />
          </Row>
        ))}
        <Row anchor="profiles.webStore">
          <Button title={t(`Open Web Store`)} onPress={() => openWebStoreFor(profile, profileId)} />
        </Row>
      </Group>
    </>
  );
}

export function ExtensionPage({ profileId, extensionId }: { profileId: string; extensionId: string }) {
  const profile = currentEngineProfile(profileId);
  const list = useExtensionList(profile);
  const [loaded] = useResource(extensionList, profile);
  const name = useProfile(profileId, (p) => p?.name ?? t(`Profile`));
  const ext = list.find((x) => x.id === extensionId);
  const gone = !ext && loaded !== undefined;
  useEffect(() => {
    if (gone) replaceSettingsPlace(profileId, null);
  }, [gone, profileId]);
  if (!ext) return null;
  return (
    <ProfileSubPage>
      <ExtensionDetails ext={ext} profile={profile} />
    </ProfileSubPage>
  );
}

function ExtensionDetails({ ext, profile }: { ext: InstalledExtension; profile: string }) {
  const openTab = (url: string) => openInExtensionProfile(url, profile);
  return (
    <View>
      <Box gap="xl" style={DETAILS_TOP}>
        <Group>
          <Row
            icon={<Image source={{ uri: ext.icon }} style={DETAILS_ICON} />}
            title={
              <Text size="large" weight="semibold">
                {ext.name}
              </Text>
            }
            description={`Version ${ext.version}${ext.fromWebStore ? " · Chrome Web Store" : " · Unpacked"}`}
          >
            <Toggle value={ext.enabled} onChange={(on) => void setEnabled(profile, ext.id, on)} />
          </Row>
        </Group>
      </Box>
      {ext.description ? (
        <Text tone="textSecondary" style={DETAILS_DESCRIPTION()}>
          {ext.description}
        </Text>
      ) : null}

      <SectionHeader title={t(`Permissions`)} />
      <Group>
        {ext.permissions.length ? (
          ext.permissions.map((p) => <Row key={p} title={p} />)
        ) : (
          <Row title={t(`This extension requires no special permissions.`)} />
        )}
        {ext.siteAccess ? (
          <Row title={t(`Site access`)} description={t(`Which sites the extension can read and change.`)}>
            <PopUp value={siteAccessOf(ext)} options={SITE_ACCESS} onChange={(siteAccess) => void configure(profile, ext.id, { siteAccess })} />
          </Row>
        ) : null}
      </Group>

      <SectionHeader title={t(`Settings`)} />
      <Group>
        <Row title={t(`Pin to toolbar`)} description={t(`Show its button next to the address.`)}>
          <Toggle value={ext.pinned} onChange={(pinned) => void setPinned(profile, ext.id, pinned)} />
        </Row>
        <Row title={t(`Allow in Incognito`)} description={t(`Incognito can't stop extensions from recording your browsing.`)}>
          <Toggle value={ext.incognito} onChange={(incognito) => void configure(profile, ext.id, { incognito })} />
        </Row>
        {ext.userScriptsAvailable ? (
          <Row
            title={t(`Allow User Scripts`)}
            description={t(`Lets it run unreviewed code, like userscripts. Only for code you trust.`)}
          >
            <Toggle value={!!ext.userScripts} onChange={(userScripts) => void configure(profile, ext.id, { userScripts })} />
          </Row>
        ) : null}
        {ext.optionsUrl ? (
          <Row title={t(`Extension options`)}>
            <Button title={t(`Open`)} onPress={() => openTab(ext.optionsUrl!)} />
          </Row>
        ) : null}
        {ext.webStoreUrl ? (
          <Row title={t(`View in Chrome Web Store`)}>
            <Button title={t(`Open`)} onPress={() => openTab(ext.webStoreUrl!)} />
          </Row>
        ) : null}
        {!ext.fromWebStore ? (
          <Row title={t(`Reload`)} description={ext.path ?? undefined}>
            <Button title={t(`Reload`)} onPress={() => void reload(profile, ext.id)} />
          </Row>
        ) : null}
        {ext.errors.length ? <Row title={t(`Errors`)} description={ext.errors.slice(0, 5).join("\n")} /> : null}
        <Row title={<Text tone="textTertiary">{`ID ${ext.id}`}</Text>} />
      </Group>

      <View style={REMOVE}>
        <Button
          title={t(`Remove Extension…`)}
          kind="destructive"
          disabled={!ext.mayModify}
          onPress={() => void removeExtension(profile, ext, SETTINGS_WINDOW_ID)}
        />
      </View>
    </View>
  );
}

const DETAILS_TOP = { marginTop: space.xl } as const;
const DETAILS_ICON = { width: 48, height: 48 } as const;
const DETAILS_DESCRIPTION = perLook(() => ({ marginTop: space.l, lineHeight: proseLineHeight.body }) as const);
const REMOVE = { alignItems: "flex-start", marginTop: space.xl } as const;
