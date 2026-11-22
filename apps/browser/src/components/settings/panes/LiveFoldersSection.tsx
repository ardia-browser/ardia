import { View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { deleteLiveFolder, manualRefresh, statusText } from "../../../state/live/engine";
import { isMocked } from "../../../state/live/net";
import { disconnect, SOURCES } from "../../../state/live/sources";
import { updateFolder, useLive } from "../../../state/live/store";
import type { LiveAccount, LiveFolder, LiveSourceId } from "../../../state/live/types";
import { useProfileRecords } from "../../../state/profiles/hooks";
import { showSettingsSheet } from "../../../state/settings/sheet";
import { Box, Button, space, Text, Toggle } from "../../ui";
import { Favicon } from "../../favicon/Favicon";
import { Group, Row, SectionHeader } from "../Form";
import { ConnectAccountSheet } from "./ConnectAccountSheet";
import { t } from "../../../lib/uiLanguage";


const ACCOUNTS: LiveSourceId[] = ["github", "bitbucket", "notion", "confluence", "gdrive"];

const PR_OPTIONS = {
  groupStacks: { title: t(`Group stacked pull requests`), description: t(`Pull requests based on each other's branches sit together under one row.`) },
  showCompleted: { title: t(`Show completed pull requests`), description: t(`Merged, closed and reviewed pull requests stay listed for a day under Completed.`) },
} as const;

export function LiveFoldersSection() {
  const folders = useLive(useShallow((s) => s.folderOrder.map((id) => s.folders[id]!).filter(Boolean)));
  const profiles = useProfileRecords();
  useLive((s) => s.status);
  useLive((s) => s.hidden);
  return (
    <View>
      <SectionHeader anchor="automations.liveFolders" />
      {folders.length ? (
        <Box gap="xl">
          {folders.map((f) => (
            <FolderGroup key={f.id} folder={f} profileName={profiles[f.profileId]?.name ?? t(`Profile`)} />
          ))}
        </Box>
      ) : (
        <Group>
          <Row title={t(`No live folders yet`)} />
        </Group>
      )}

      <SectionHeader title={t(`Connected accounts`)} description={t(`Live folders read from these accounts.`)} />
      <Group>
        {ACCOUNTS.map((id) => (
          <AccountRow key={id} id={id} />
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

function FolderGroup({ folder, profileName }: { folder: LiveFolder; profileName: string }) {
  return (
    <Group>
      <Row title={folder.name} description={`${profileName} · ${folder.sources.map((s) => SOURCES[s].name).join(", ")} · ${statusText(folder.id)}`}>
        <Box row gap="s">
          <Button title={t(`Refresh`)} onPress={() => void manualRefresh(folder.id)} />
          <Button title={t(`Delete`)} kind="destructive" onPress={() => deleteLiveFolder(folder.id)} />
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

function AccountRow({ id }: { id: LiveSourceId }) {
  const account = useLive((s) => s.accounts[id]);
  const source = SOURCES[id];
  return (
    <Row anchor={`automations.${id}`} icon={<Favicon url={source.site} size={18} />} title={source.name} description={account ? `Connected as ${connectedAs(id, account)}` : undefined}>
      {account ? <Button title={t(`Disconnect`)} onPress={() => void disconnect(id)} /> : <Button title={t(`Connect…`)} onPress={() => showSettingsSheet(<ConnectAccountSheet id={id} />)} />}
    </Row>
  );
}

const NOTE_TOP = { marginTop: space.ml } as const;
