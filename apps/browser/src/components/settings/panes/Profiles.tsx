import { chooseFromMenu } from "../../../state/app/menuChoice";
import { useState } from "react";
import { pickFolder, showMenu } from "../../../state/app/system";
import { requestDeleteProfile, updateProfile } from "../../../state/profiles/actions";
import { useProfile, useProfilePrivateWindows, useProfileSpaces, useProfiles } from "../../../state/profiles/hooks";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";
import { Button, Box, ContextMenuArea, Text, TextField } from "../../ui";
import { ClearDataDialog } from "../../pages/ClearDataDialog";
import { iconMenuItems } from "../../spaces/SpaceIcons";
import { createProfileInSettings } from "../ProfileForm";
import { SearchSection, OtherEnginesPage } from "./ProfileSearch";
import { PasswordsPage, PasswordsSection } from "./ProfilePasswords";
import { AddressesPage, CardsPage } from "./ProfileAutofill";
import { ExtensionPage, ExtensionsSection } from "./ProfileExtensions";
import { ExportBookmarksRow } from "./ExportBookmarksRow";
import { SitePage, SitesPage } from "./SiteSettings";
import { PreloadPagesRow } from "./PreloadPagesRow";
import { downloadSettings, setDownloadsFor } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { detailValue, SETTINGS_DETAIL, type SettingsPlace } from "../../../state/settings/settingsWindows";
import { Group, Row, SectionHeader } from "../Form";

export function ProfilesPane({ spaceId: profileId, detail }: SettingsPlace) {
  if (!profileId) return <ProfileList />;
  if (detail === SETTINGS_DETAIL.otherEngines) return <OtherEnginesPage profileId={profileId} />;
  if (detail === SETTINGS_DETAIL.passwords) return <PasswordsPage profileId={profileId} />;
  if (detail === SETTINGS_DETAIL.addresses) return <AddressesPage profileId={profileId} />;
  if (detail === SETTINGS_DETAIL.cards) return <CardsPage profileId={profileId} />;
  if (detail === SETTINGS_DETAIL.sites) return <SitesPage profileId={profileId} />;
  const site = detailValue(detail, "site");
  if (site) return <SitePage key={site} profileId={profileId} origin={site} />;
  const extension = detailValue(detail, "extension");
  if (extension) return <ExtensionPage key={extension} profileId={profileId} extensionId={extension} />;
  return <ProfileDetailsPane key={profileId} profileId={profileId} />;
}

function ProfileList() {
  const profiles = useProfiles();
  const menu = async (id: string) => {
    const choice = await showMenu([{ id: "edit", title: "Edit Profile…" }, { id: "delete", title: "Delete Profile…" }]);
    if (choice === "delete") void requestDeleteProfile(id);
    else if (choice === "edit") goToSettingsPane("profiles", id);
  };
  return <Box gap="l">
    <Text tone="textSecondary">Profiles hold your logins, history, bookmarks, extensions and Top Apps. Several spaces can use one profile.</Text>
    <SectionHeader title="Profiles" anchor="profiles.list" action={<Button title="Create Profile" icon="plus" onPress={() => createProfileInSettings((id) => goToSettingsPane("profiles", id))} />} />
    <Group>{profiles.map((profile) => <ContextMenuArea key={profile.id} onContextMenu={() => void menu(profile.id)}><Row title={profile.name}>
      <Button title="Edit…" onPress={() => goToSettingsPane("profiles", profile.id)} />
      <Button variant="icon" icon="trash" tooltip="Delete Profile…" onPress={() => void requestDeleteProfile(profile.id)} />
    </Row></ContextMenuArea>)}</Group>
  </Box>;
}

export function ProfileDetailsPane({ profileId }: { profileId: string }) {
  const profile = useProfile(profileId);
  const spaces = useProfileSpaces(profileId);
  const privateWindows = useProfilePrivateWindows(profileId);
  const profiles = useProfiles();
  const [name, setName] = useState(profile?.name ?? "");
  const [downloads] = useResource(downloadSettings, profile?.engineId ?? "");
  if (!profile) return null;
  const commit = () => name.trim() ? updateProfile(profileId, { name: name.trim() }) : setName(profile.name);
  const remove = async () => {
    if (await requestDeleteProfile(profileId)) goToSettingsPane("profiles");
  };
  const icon = async () => {
    const choice = await chooseFromMenu(iconMenuItems(profile.icon));
    if (choice && typeof choice === "object") updateProfile(profileId, { icon: choice.icon });
  };
  const changeDownloads = async () => {
    if (!downloads || downloads.managed) return;
    const folder = await pickFolder(downloads.folder, "Use Folder");
    if (folder) await setDownloadsFor({ folder }, [profile.engineId]);
  };
  return <Box gap="l">
    <SectionHeader title="Profile" />
    <Group>
      <Row title="Name"><TextField value={name} onChangeText={setName} onBlur={commit} onSubmit={commit} style={{ width: 220 }} /></Row>
      <Row title="Icon" description={profile.icon ?? "Initial"}><Button title="Change…" onPress={() => void icon()} /></Row>
      <Row title="Assigned spaces" description={`${spaces.length} ${spaces.length === 1 ? "space uses" : "spaces use"} this profile.`} />
      <Row anchor="profiles.profileDownloadsFolder" description={downloads?.folder.replace(/^\/Users\/[^/]+(?=\/|$)/, "~")}>
        <Button title="Change…" disabled={!downloads || downloads.managed} onPress={() => void changeDownloads()} />
      </Row>
      {PLATFORM_FEATURES.preloadPages ? <PreloadPagesRow profileId={profileId} /> : null}
      <Row anchor="profiles.siteSettings" onPress={() => goToSettingsPane("profiles", profileId, SETTINGS_DETAIL.sites)} />
    </Group>
    <SearchSection profileId={profileId} />
    <PasswordsSection profileId={profileId} />
    <ExtensionsSection profileId={profileId} />
    <SectionHeader title="Browsing data" />
    <Group>
      <Row anchor="profiles.clearBrowsingData" description="Affects every space using this profile. Saved sidebar rows and folders stay.">
        <Button title="Clear…" onPress={() => showSettingsSheet(<ClearDataDialog profileId={profileId} onClose={closeSettingsSheet} />)} />
      </Row>
      <ExportBookmarksRow profileId={profileId} />
      <Row title="Delete Profile" description={profiles.length <= 1 ? "Keep at least one profile." : privateWindows ? "Close this profile’s private windows first." : spaces.length ? "Its spaces will be reassigned to another profile when deleted." : `Deletes its browsing data on this ${PLATFORM_TERMS.computer}.`}>
        <Button title="Delete…" kind="destructive" onPress={() => void remove()} />
      </Row>
    </Group>
  </Box>;
}
