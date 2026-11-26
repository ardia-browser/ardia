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
import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { currentEngineProfile } from "../../../state/browser/current";
import { InstallDialogHost } from "../../extensions/ExtensionOverlays";
import { Box, Button, DialogActions, DialogTitle, PopUp, proseLineHeight, Sheet, space, Text, TextField, Toggle } from "../../ui";
import { FormField, Group, Row, SectionHeader } from "../Form";
import { addExtensionSite, extensionSiteLabel, noteExtensionSitePickerCancelled, removeExtensionSite } from "../../../state/extensions/siteAccess";
import { PasswordAppPairingRow } from "./PasswordAppPairingRow";
import { extensionList } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { replaceSettingsPlace, SETTINGS_WINDOW_ID } from "../../../state/settings/settingsWindows";
import { prompt, showMenu } from "../../../state/app/system";
import { perLook } from "../../ui/tokens";
import { ProfileSubPage } from "./ProfileSubPage";

type SiteAccess = "allSites" | "specificSites" | "onClick";
const SITE_ACCESS: { value: SiteAccess; title: string }[] = [
  { value: "allSites", title: "On all sites" },
  { value: "specificSites", title: "On specific sites" },
  { value: "onClick", title: "On click" },
];
const siteAccessOf = (ext: InstalledExtension): SiteAccess =>
  ext.siteAccess === "ON_CLICK" ? "onClick" : ext.siteAccess === "ON_SPECIFIC_SITES" ? "specificSites" : "allSites";

const showInstall = () => showSettingsSheet(<InstallDialogHost windowId={SETTINGS_WINDOW_ID} onClosed={closeSettingsSheet} />);

async function addFromLink(profile: string) {
  const link = await prompt({
    title: "Add Extension from a Link",
    message: "Paste a Chrome Web Store link or extension ID.",
    placeholder: "chromewebstore.google.com/detail/…",
    confirmTitle: "Add",
  });
  if (!link?.trim()) return;
  void addFromWebStore(SETTINGS_WINDOW_ID, link.trim(), profile);
  showInstall();
}

async function openMoreMenu(profile: string) {
  const choice = await showMenu([
    { id: "link", title: "Add from a Link…", symbol: "link" },
    { id: "unpacked", title: "Load Unpacked Extension…", symbol: "folder" },
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
        title="Extensions"
        action={<Button variant="icon" icon="ellipsis" size="m" tooltip="More" onPress={() => void openMoreMenu(profile)} />}
      />
      <Group>
        <Row anchor="profiles.extensions" description={list.length ? undefined : "Extensions you add appear here and in the Extensions menu. Each profile has its own."} />
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
          <Button title="Open Web Store" onPress={() => openWebStoreFor(profile, profileId)} />
        </Row>
      </Group>
    </>
  );
}

export function ExtensionPage({ profileId, extensionId }: { profileId: string; extensionId: string }) {
  const profile = currentEngineProfile(profileId);
  const list = useExtensionList(profile);
  const [loaded] = useResource(extensionList, profile);
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

      <SectionHeader title="Permissions" />
      <Group>
        {ext.permissions.length ? (
          ext.permissions.map((p) => <Row key={p} title={p} />)
        ) : (
          <Row title="This extension requires no special permissions." />
        )}
        {ext.siteAccess ? <SiteAccessDetails ext={ext} profile={profile} /> : null}
      </Group>
      <PasswordAppPairingRow extensionId={ext.id} />

      <SectionHeader title="Settings" />
      <Group>
        <Row title="Pin to toolbar" description="Show its button next to the address.">
          <Toggle value={ext.pinned} onChange={(pinned) => void setPinned(profile, ext.id, pinned)} />
        </Row>
        <Row title="Allow in Incognito" description="Incognito can't stop extensions from recording your browsing.">
          <Toggle value={ext.incognito} onChange={(incognito) => void configure(profile, ext.id, { incognito })} />
        </Row>
        {ext.userScriptsAvailable ? (
          <Row
            title="Allow User Scripts"
            description="Lets it run unreviewed code, like userscripts. Only for code you trust."
          >
            <Toggle value={!!ext.userScripts} onChange={(userScripts) => void configure(profile, ext.id, { userScripts })} />
          </Row>
        ) : null}
        {ext.optionsUrl ? (
          <Row title="Extension options">
            <Button title="Open" onPress={() => openTab(ext.optionsUrl!)} />
          </Row>
        ) : null}
        {ext.webStoreUrl ? (
          <Row title="View in Chrome Web Store">
            <Button title="Open" onPress={() => openTab(ext.webStoreUrl!)} />
          </Row>
        ) : null}
        {!ext.fromWebStore ? (
          <Row title="Reload" description={ext.path ?? undefined}>
            <Button title="Reload" onPress={() => void reload(profile, ext.id)} />
          </Row>
        ) : null}
        {ext.errors.length ? <Row title="Errors" description={ext.errors.slice(0, 5).join("\n")} /> : null}
        <Row title={<Text tone="textTertiary">{`ID ${ext.id}`}</Text>} />
      </Group>

      <View style={REMOVE}>
        <Button
          title="Remove Extension…"
          kind="destructive"
          disabled={!ext.mayModify}
          onPress={() => void removeExtension(profile, ext, SETTINGS_WINDOW_ID)}
        />
      </View>
    </View>
  );
}

function SiteAccessDetails({ ext, profile }: { ext: InstalledExtension; profile: string }) {
  const access = siteAccessOf(ext);
  const [problem, setProblem] = useState<{ site: string; message: string } | null>(null);
  const addSite = () => showSettingsSheet(<AddSiteSheet ext={ext} profile={profile} />);
  const choose = (siteAccess: SiteAccess) => (siteAccess === "specificSites" ? addSite() : void configure(profile, ext.id, { siteAccess }));
  const remove = async (site: string) => {
    setProblem(null);
    const message = await removeExtensionSite(profile, ext.id, site);
    if (message) setProblem({ site, message });
  };
  return (
    <>
      <Row title="Site access" description="Which sites the extension can read and change.">
        <PopUp value={access} options={SITE_ACCESS} onChange={choose} />
      </Row>
      {access === "specificSites"
        ? ext.sites.map((site) => (
            <Row key={site} title={extensionSiteLabel(site)} description={problem?.site === site ? problem.message : undefined}>
              <Button title="Remove" onPress={() => void remove(site)} />
            </Row>
          ))
        : null}
      {access === "specificSites" ? (
        <Row>
          <Button title="Add Site…" onPress={addSite} />
        </Row>
      ) : null}
    </>
  );
}

function AddSiteSheet({ ext, profile }: { ext: InstalledExtension; profile: string }) {
  const [site, setSite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const cancel = () => {
    if (saving) return;
    noteExtensionSitePickerCancelled();
    closeSettingsSheet();
  };
  const add = async () => {
    if (saving || !site.trim()) return;
    setSaving(true);
    const problem = await addExtensionSite(profile, ext.id, site);
    setSaving(false);
    if (problem) return setError(problem);
    closeSettingsSheet();
  };
  return (
    <Sheet onClose={cancel}>
      <DialogTitle subtitle={`${ext.name} reads and changes only the sites you add.`}>Add Site</DialogTitle>
      <FormField label="Site">
        <TextField value={site} onChangeText={(text) => (setSite(text), setError(null))} placeholder="example.com" onSubmit={() => void add()} onEscape={cancel} autoFocus />
      </FormField>
      {error ? (
        <Text size="caption" tone="destructive" style={SHEET_ERROR}>
          {error}
        </Text>
      ) : null}
      <DialogActions>
        <Button title="Cancel" disabled={saving} onPress={cancel} />
        <Button title="Add" kind="primary" disabled={saving || !site.trim()} onPress={() => void add()} />
      </DialogActions>
    </Sheet>
  );
}

const SHEET_ERROR = { marginTop: space.ml } as const;
const DETAILS_TOP = { marginTop: space.xl } as const;
const DETAILS_ICON = { width: 48, height: 48 } as const;
const DETAILS_DESCRIPTION = perLook(() => ({ marginTop: space.l, lineHeight: proseLineHeight.body }) as const);
const REMOVE = { alignItems: "flex-start", marginTop: space.xl } as const;
