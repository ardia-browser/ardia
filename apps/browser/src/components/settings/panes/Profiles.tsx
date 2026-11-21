import { Box, Button, PopUp, space, Text, TextField, Toggle } from "../../ui";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { deleteProfile } from "../../../state/browser/actions";
import { profileAccent } from "../../ui/theme";
import { useDataSharingProfileIds, useProfileDataStats, useProfileOrder, useProfileRecords, useTopAppSiblingNames } from "../../../state/profiles/hooks";
import { currentEngineProfile, currentProfiles } from "../../../state/browser/current";
import { chooseIcon, commitProfileName, setDefaultProfile, setShareTopApps } from "../../../state/profiles/actions";
import { openProfileIconPicker } from "../../../state/profiles/iconPicker";
import { useProfile, useProfiles, useSettings } from "../../../state/browser/hooks";
import { ClearDataDialog } from "../../pages/ClearDataDialog";
import { Anchor, Group, Row, SectionHeader, SettingToggle, useHiddenSetting } from "../Form";
import { ColorStack } from "../../profiles/CreateProfile";
import { PROFILE_SYMBOLS, ProfileBadge } from "../../profiles/ProfileIcons";
import { iconSymbol } from "../../../lib/customIcon";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { ThemeSection } from "../ThemeEditor";
import { detailValue, goToSettingsPane, replaceSettingsPlace, SETTINGS_DETAIL, SETTINGS_WINDOW_ID, type SettingsPlace } from "../../../state/settings/settingsWindows";
import { setOpenTabsSynced, setProfileSynced, useSync } from "../../../state/sync/engine";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { pickFolder } from "../../../state/app/system";
import { downloadSettings, setDownloadsFor } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { findSetting, setting } from "../settingsIndex";
import { ExportBookmarksRow } from "./ExportBookmarksRow";
import { PreloadPagesRow } from "./PreloadPagesRow";
import { listOf, ProfileBar, useSharedWith } from "./ProfileSwitcher";
import { useSelectedProfile } from "./ProfileSubPage";
import { OtherEnginesPage, SearchSection } from "./ProfileSearch";
import { PasswordsPage, PasswordsSection } from "./ProfilePasswords";
import { AddressesPage, CardsPage } from "./ProfileAutofill";
import { ExtensionPage, ExtensionsSection } from "./ProfileExtensions";
import { SitePage, SitesPage } from "./SiteSettings";

export function ProfilesPane({ profileId: chosen, detail }: SettingsPlace) {
  const profileId = useSelectedProfile(chosen);
  if (detail === SETTINGS_DETAIL.otherEngines) return <OtherEnginesPage profileId={profileId} />;
  if (detail === SETTINGS_DETAIL.passwords) return <PasswordsPage profileId={profileId} />;
  if (detail === SETTINGS_DETAIL.addresses) return <AddressesPage profileId={profileId} />;
  if (detail === SETTINGS_DETAIL.cards) return <CardsPage profileId={profileId} />;
  if (detail === SETTINGS_DETAIL.sites) return <SitesPage profileId={profileId} />;
  const site = detailValue(detail, "site");
  if (site) return <SitePage key={site} profileId={profileId} origin={site} />;
  const extension = detailValue(detail, "extension");
  if (extension) return <ExtensionPage key={extension} profileId={profileId} extensionId={extension} />;
  return <ProfileOverview profileId={profileId} />;
}

function ProfileOverview({ profileId }: { profileId: string }) {
  return (
    <View>
      <AllProfilesSection />
      <Anchor id="profiles.profiles" keep shape="card">
        <ProfileBar selectedId={profileId} />
      </Anchor>
      <View key={profileId}>
        <ThisProfileSection profileId={profileId} />
        <SearchSection profileId={profileId} />
        <PasswordsSection profileId={profileId} />
        <ExtensionsSection profileId={profileId} />
        <DataSection profileId={profileId} />
      </View>
    </View>
  );
}

function AllProfilesSection() {
  const profiles = useProfiles();
  const defaultId = useSettings((s) => s.defaultProfileId);
  const shareable = useDataSharingProfileIds();

  return (
    <>
      <SectionHeader
        title="All profiles"
        description="Each profile keeps its own history, logins, cookies and extensions, unless it was created to share another's data."
      />
      <Group>
        <Row anchor="profiles.defaultProfile">
          <PopUp
            value={defaultId}
            options={profiles.map((p) => ({ value: p.id, title: p.name }))}
            onChange={(id) => setDefaultProfile(id)}
            minWidth={160}
            accessibilityLabel={setting("profiles.defaultProfile").title}
          />
        </Row>
        <SettingToggle anchor="profiles.showProfileDots" />
        <Row
          anchor="profiles.shareTopApps"
          description={shareable.length ? "For profiles that share data: the same Top Apps, one live page each." : "For profiles that share data with another. None do yet."}
        />
        {shareable.map((id) => (
          <ShareTopAppsRow key={id} profileId={id} />
        ))}
        <SettingToggle anchor="profiles.spacesFollowAppearance" />
      </Group>
    </>
  );
}

function useTopAppsDescription(profileId: string): string {
  const own = useProfile(profileId, (p) => !p?.shareTopApps);
  const sharing = useTopAppSiblingNames(profileId);
  const shared = useSharedWith(profileId);
  const others = useProfileRecords(useShallow((profiles) => shared.filter((id) => id !== profileId).map((id) => profiles[id]?.name ?? "")));
  if (own) return "Keeps its own Top Apps.";
  return sharing.length ? `Same Top Apps as ${listOf(sharing)}, one live page each.` : `Shares once ${listOf(others, "or")} does.`;
}

function ShareTopAppsRow({ profileId }: { profileId: string }) {
  const profile = useProfile(profileId, (p) => p);
  const description = useTopAppsDescription(profileId);
  if (!profile) return null;
  return (
    <Row icon={<ProfileBadge profile={profile} size={20} />} title={profile.name} description={description}>
      <Toggle value={!!profile.shareTopApps} accessibilityLabel={`Share Top Apps in ${profile.name}`} onChange={(share) => setShareTopApps(profileId, share)} />
    </Row>
  );
}

function iconTitle(icon: string | null): string {
  const symbol = iconSymbol(icon);
  if (symbol) return PROFILE_SYMBOLS.find((s) => s.name === symbol)?.title ?? "Symbol";
  return icon ?? "None";
}

const homeRelative = (path: string) => path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

function ThisProfileSection({ profileId }: { profileId: string }) {
  const profile = useProfile(profileId, (p) => p);
  const shared = useSharedWith(profileId);
  const sharedNames = useProfileRecords(useShallow((profiles) => shared.map((id) => profiles[id]?.name ?? "")));
  const sharedColors = useProfileRecords(useShallow((profiles) => shared.map((id) => profileAccent(profiles[id]))));
  const stats = useProfileDataStats(profileId);
  const syncLink = useSync((s) => s.profiles[profileId]);
  const synced = useSync((s) => s.enabled && !!s.profiles[profileId]?.enabled);
  const syncsTabs = useSync((s) => s.types.tabs);
  const engineProfile = currentEngineProfile(profileId);
  const [downloads] = useResource(downloadSettings, engineProfile);
  const savedName = profile?.name ?? "";
  const [name, setName] = useState(savedName);
  const typed = useRef(name);
  typed.current = name;
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current) setName(savedName);
  }, [savedName]);
  useEffect(
    () => () => {
      if (edited.current) commitProfileName(profileId, typed.current);
    },
    [profileId],
  );
  const badge = useRef<View>(null);
  const changeButton = useRef<View>(null);
  if (!profile) return null;
  const editName = (text: string) => {
    edited.current = true;
    setName(text);
  };
  const commitName = () => {
    edited.current = false;
    setName(commitProfileName(profileId, name) ? name.trim() : profile.name);
  };
  const sharing = shared.length > 1;
  const pickIcon = (anchor: View | null) => void openProfileIconPicker(profileId, SETTINGS_WINDOW_ID, "settings", anchor);
  const changeDownloads = async () => {
    if (!downloads) return;
    const folder = await pickFolder(downloads.folder, "Use Folder");
    if (folder) void setDownloadsFor({ folder }, [engineProfile]);
  };

  return (
    <>
      <Box gap="ml" style={DETAILS_HEAD}>
        <Pressable onPress={() => pickIcon(badge.current)} tooltip="Change Icon">
          <View ref={badge} collapsable={false}>
            <ProfileBadge profile={profile} size={64} />
          </View>
        </Pressable>
        <Box center gap="xxs">
          <Text size="title" weight="semibold">
            {profile.name}
          </Text>
          <Text size="small" tone="textSecondary">
            {stats}
          </Text>
        </Box>
      </Box>

      <SectionHeader title="This profile" />
      <Group>
        <Row title="Name">
          <TextField value={name} onChangeText={editName} onSubmit={commitName} onBlur={commitName} width={220} />
        </Row>
        <Row title="Icon" description={iconTitle(profile.icon)}>
          <Box row gap="s">
            {profile.icon ? <Button title="Remove" onPress={() => chooseIcon(profileId, null)} /> : null}
            <View ref={changeButton} collapsable={false}>
              <Button title={profile.icon ? "Change…" : "Add…"} onPress={() => pickIcon(changeButton.current)} />
            </View>
          </Box>
        </Row>
        {sharing ? (
          <Row
            icon={<ColorStack colors={sharedColors} size={14} />}
            title="Shared data"
            description={`${listOf(sharedNames)} share Cookies, Passwords, Extensions, Bookmarks, and History. Each keeps its own tabs.`}
          />
        ) : null}
        <Row anchor="profiles.syncThisProfile" description={sharing ? "Its tabs sync here; the data it shares syncs with the profile that owns it." : undefined}>
          <Toggle value={!!syncLink?.enabled} disabled={!syncLink} accessibilityLabel={setting("profiles.syncThisProfile").title} onChange={(on) => setProfileSynced(profileId, on)} />
        </Row>
        {synced ? (
          <Row title="Sync All Open Tabs" description={`Every open tab in this profile, not just pinned ones, is the same on all your ${PLATFORM_TERMS.syncedComputer}s.`}>
            <Toggle value={!!profile.syncTabs} disabled={!syncsTabs} accessibilityLabel="Sync All Open Tabs" onChange={(on) => setOpenTabsSynced(profileId, on)} />
          </Row>
        ) : null}
        <Row
          anchor="profiles.profileDownloadsFolder"
          description={downloads ? (downloads.managed ? `${homeRelative(downloads.folder)}, set by your organization.` : homeRelative(downloads.folder)) : undefined}
        >
          <Button title="Change…" disabled={!downloads || downloads.managed} onPress={() => void changeDownloads()} />
        </Row>
        {PLATFORM_FEATURES.preloadPages ? <PreloadPagesRow profileId={profileId} /> : null}
        <Row anchor="profiles.siteSettings" onPress={() => goToSettingsPane("profiles", profileId, SETTINGS_DETAIL.sites)} />
      </Group>

      <ThemeSection profileId={profileId} />
    </>
  );
}

function DataSection({ profileId }: { profileId: string }) {
  const hidden = useHiddenSetting();
  const only = useProfileOrder((o) => o.length <= 1);
  const sharing = useSharedWith(profileId).length > 1;

  return (
    <>
      <SectionHeader title="Data" />
      <Group>
        {hidden(findSetting("profiles.exportBookmarks")) ? null : <ExportBookmarksRow key={profileId} profileId={profileId} />}
        <Row
          anchor="profiles.clearBrowsingData"
          description={sharing ? "History, cookies, site data and cached files, for every profile that shares them." : "History, cookies, site data and cached files for this profile."}
        >
          <Button title="Clear…" onPress={() => showSettingsSheet(<ClearDataDialog profileId={profileId} onClose={closeSettingsSheet} />)} />
        </Row>
        <Row
          title="Delete profile"
          description={only ? "You can't delete your only profile." : sharing ? "Removes its tabs. The data it shares stays." : "Removes its tabs, history, bookmarks and site data."}
        >
          <Button
            title="Delete…"
            kind="destructive"
            disabled={only}
            onPress={() =>
              void deleteProfile(profileId).then(() => {
                if (!currentProfiles()[profileId]) replaceSettingsPlace(null);
              })
            }
          />
        </Row>
      </Group>
    </>
  );
}

const DETAILS_HEAD = { alignItems: "center", marginTop: space.xxl } as const;
