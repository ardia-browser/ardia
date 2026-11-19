import { useEffect } from "react";
import { View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { deleteLiveFolder, manualRefresh, statusText } from "../../../state/live/engine";
import { isMocked } from "../../../state/live/net";
import { disconnect, SOURCES } from "../../../state/live/sources";
import { updateFolder, useLive } from "../../../state/live/store";
import { extensionsProfileId } from "../../../state/extensions/store";
import type { LiveAccount, LiveFolder, LiveSourceId } from "../../../state/live/types";
import { useProfileRecords } from "../../../state/profiles/hooks";
import { showSettingsSheet } from "../../../state/settings/sheet";
import { Box, Button, space, Text, Toggle } from "../../ui";
import { Favicon } from "../../favicon/Favicon";
import { Group, ProfilePicker, Row, SectionHeader, useSettingsProfile } from "../Form";
import { ConnectAccountSheet } from "./ConnectAccountSheet";

const ACCOUNTS: LiveSourceId[] = ["github", "bitbucket", "notion", "confluence", "gdrive"];

const PR_OPTIONS = {
  groupStacks: { title: "Group stacked pull requests", description: "Pull requests based on each other's branches sit together under one row." },
  showCompleted: { title: "Show completed pull requests", description: "Merged, closed and reviewed pull requests stay listed for a day under Completed." },
} as const;

export function LiveFoldersSection({ profileId: chosen }: { profileId: string | null }) {
  const [profileId, setProfileId] = useSettingsProfile(extensionsProfileId(chosen));
  const profileExists = useProfileRecords((profiles) => !!profiles[profileId]);
  useEffect(() => {
    if (!profileExists) setProfileId(extensionsProfileId(null));
  }, [profileExists, setProfileId]);
  const folders = useLive(useShallow((s) => s.folderOrder.map((id) => s.folders[id]!).filter((f) => f?.profileId === profileId)));
  useLive((s) => s.status);
  useLive((s) => s.hidden);
  return (
    <View>
      <SectionHeader anchor="automations.liveFolders" action={<ProfilePicker value={profileId} onChange={setProfileId} />} />
      {folders.length ? (
        <Box gap="xl">
          {folders.map((f) => (
            <FolderGroup key={f.id} folder={f} />
          ))}
        </Box>
      ) : (
        <Group>
          <Row title="No live folders yet" />
        </Group>
      )}

      <SectionHeader title="Connected accounts" description="Live folders read from these accounts." />
      <Group>
        {ACCOUNTS.map((id) => (
          <AccountRow key={id} id={id} profileId={profileId} />
        ))}
      </Group>
      {isMocked ? (
        <Text size="caption" tone="warning" style={NOTE_TOP}>
          Development build: services are served by ARDIA_TEST liveMock.
        </Text>
      ) : null}
    </View>
  );
}

function FolderGroup({ folder }: { folder: LiveFolder }) {
  return (
    <Group>
      <Row title={folder.name} description={`${folder.sources.map((s) => SOURCES[s].name).join(", ")} · ${statusText(folder.id)}`}>
        <Box row gap="s">
          <Button title="Refresh" onPress={() => void manualRefresh(folder.id)} />
          <Button title="Delete" kind="destructive" onPress={() => deleteLiveFolder(folder.id)} />
        </Box>
      </Row>
      {folder.kind === "pullRequests"
        ? [
            <FolderOption key="stacks" option="groupStacks" value={folder.groupStacks} onChange={(v) => updateFolder(folder.id, { groupStacks: v })} />,
            <FolderOption key="completed" option="showCompleted" value={folder.showCompleted} onChange={(v) => updateFolder(folder.id, { showCompleted: v })} />,
          ]
        : null}
    </Group>
  );
}

function FolderOption({ option, value, onChange }: { option: keyof typeof PR_OPTIONS; value: boolean; onChange(value: boolean): void }) {
  const { title, description } = PR_OPTIONS[option];
  return (
    <Row title={title} description={description}>
      <Toggle value={value} accessibilityLabel={title} onChange={onChange} />
    </Row>
  );
}

function connectedAs(id: LiveSourceId, account: LiveAccount): string {
  if (!account.name || account.name === account.login) return account.login;
  return id === "github" || id === "gdrive" ? `${account.name} (${account.login})` : account.name;
}

function AccountRow({ id, profileId }: { id: LiveSourceId; profileId: string }) {
  const account = useLive((s) => s.accounts[profileId]?.[id]);
  const source = SOURCES[id];
  return (
    <Row anchor={`automations.${id}`} icon={<Favicon url={source.site} size={18} />} title={source.name} description={account ? `Connected as ${connectedAs(id, account)}` : undefined}>
      {account ? <Button title="Disconnect" onPress={() => void disconnect(profileId, id)} /> : <Button title="Connect…" onPress={() => showSettingsSheet(<ConnectAccountSheet id={id} profileId={profileId} />)} />}
    </Row>
  );
}

const NOTE_TOP = { marginTop: space.ml } as const;
