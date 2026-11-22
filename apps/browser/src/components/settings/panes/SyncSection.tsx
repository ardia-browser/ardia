import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { showMenu } from "../../../state/app/system";
import { Button, Dot, lineHeight, space, Symbol, Text } from "../../ui";
import { perLook } from "../../ui/tokens";
import { useTheme } from "../../ui/theme";
import { copyRecoveryPhrase, revealSyncFolder, type FolderInfo } from "../../../state/sync/recoveryKit";
import { syncFolder } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { useProfiles } from "../../../state/browser/hooks";
import { chooseSyncFolder, folderInfo, setOpenTabsSynced, setTypeSynced, syncNow, turnOnSync, useSync } from "../../../state/sync/engine";
import { DATA_TYPES, type SyncStatus } from "../../../state/sync/syncDoc";
import { deviceDetail } from "../../../state/sync/devices";
import { Group, Row, SectionHeader } from "../Form";
import { addAllRemoteProfiles, confirmRemoveDevice, folderLabel, lookingForProfiles, RemoteProfileRow, showConnectDevice, showPhraseEntry, showRecoveryKit, showStopSync } from "./SyncSheets";
import { ago } from "../../../lib/time";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { Checklist } from "./Checklist";
import { t } from "../../../lib/uiLanguage";


function statusLine(status: SyncStatus, lastSyncedAt: number | null, pending: number): string {
  const since = lastSyncedAt ? ago(lastSyncedAt) : null;
  const line = (() => {
    switch (status) {
      case "starting":
        return t(`Starting up`);
      case "updating":
        return t(`Updating`);
      case "offline":
        return t(`Offline`);
      case "stalled":
      case "locked":
        return since ? `Not syncing · last synced ${since}` : t(`Not syncing`);
      default:
        return since && since !== t(`just now`) ? `Updated ${since}` : t(`Updated just now`);
    }
  })();
  return pending ? `${line} · waiting for ${pending === 1 ? "1 file" : `${pending} files`} to download` : line;
}

export function SyncSection() {
  const enabled = useSync((s) => s.enabled);
  const status = useSync((s) => s.status);
  const folder = useSync((s) => s.folder);
  const [loaded, reload] = useResource(syncFolder, folder ?? null);
  const info = loaded ?? null;
  useEffect(() => {
    void reload();
  }, [enabled, status]);

  if (status === "unavailable") {
    return (
      <>
        <SectionHeader title={t(`Sync`)} />
        <Group>
          <Row anchor="general.sync" description={t(`Sync isn’t available in this build.`)} />
        </Group>
      </>
    );
  }
  return enabled ? <SyncOn info={info} /> : <SyncOff info={info} />;
}

function SyncIcon({ on }: { on: boolean }) {
  const theme = useTheme();
  return (
    <Dot size={SYNC_ICON} color={on ? theme.formAccent : theme.control} ring={on ? undefined : theme.controlBorder}>
      <Symbol name="arrow.triangle.2.circlepath" size={13} weight="semibold" color={on ? theme.onAccent : theme.icon} style={SYNC_GLYPH} />
    </Dot>
  );
}

function SyncOff({ info }: { info: FolderInfo | null }) {
  const theme = useTheme();
  const status = useSync((s) => s.status);
  const error = useSync((s) => s.error);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const noICloud = !!info && info.path === info.defaultPath && !info.iCloudAvailable;
  const hasData = !!info?.hasSyncData;

  const turnOn = async () => {
    if (!info) return;
    setBusy(true);
    setFailure(null);
    const result = await turnOnSync(info.path);
    setBusy(false);
    if ("error" in result) setFailure(result.error);
    else showRecoveryKit();
  };
  const enterPhrase = () => showPhraseEntry(info, () => void chooseSyncFolder().then(() => folderInfo().then((i) => showPhraseEntry(i))));
  const otherOptions = async () => {
    const choice = await showMenu([
      { id: "folder", title: t(`Choose Sync Folder…`) },
      { separator: true },
      ...(hasData ? [{ id: "new", title: t(`Set Up Without Another Device`), enabled: !noICloud }] : []),
      { id: "phrase", title: t(`Enter Recovery Phrase…`) },
    ]);
    if (choice === "folder") void chooseSyncFolder();
    else if (choice === "new") void turnOn();
    else if (choice === "phrase") enterPhrase();
  };
  const where = info ? `Syncs through ${folderLabel(info)}.` : "";

  return (
    <>
      <SectionHeader title={t(`Sync`)} />
      <Group>
        <Row
          icon={<SyncIcon on={false} />}
          anchor="general.sync"
          description={
            status === "reset" && error
              ? error
              : hasData
                ? t(`This folder has synced data already. To sync with your other devices, enter the recovery phrase from one of them.`)
                : `Off. Your ${PLATFORM_TERMS.syncedComputer}s meet in a folder you choose, end-to-end encrypted. ${where}`
          }
        >
          <Button title={t(`More`)} onPress={() => void otherOptions()} />
          {hasData ? (
            <Button title={t(`Enter Recovery Phrase…`)} kind="primary" onPress={enterPhrase} />
          ) : (
            <Button title={busy ? t(`Turning On…`) : t(`Turn On`)} kind="primary" disabled={busy || noICloud || !info} onPress={() => void turnOn()} />
          )}
        </Row>
        {noICloud ? (
          <Row
            icon={<Symbol name="exclamationmark.icloud" size={14} color={theme.warning} style={WARNING_ICON} />}
            title={`${PLATFORM_TERMS.cloudDrive} is off on this ${PLATFORM_TERMS.computer}`}
            description={`${PLATFORM_TERMS.turnOnCloudDrive}, or pick any folder that syncs, like Dropbox.`}
          >
            {PLATFORM_TERMS.cloudDriveSettingsUrl ? <Button title={t(`Open iCloud Settings`)} onPress={() => void Linking.openURL(PLATFORM_TERMS.cloudDriveSettingsUrl)} /> : null}
            <Button title={t(`Choose…`)} onPress={() => void chooseSyncFolder()} />
          </Row>
        ) : null}
      </Group>
      {failure ? (
        <Text size="caption" tone="destructive" style={FAILURE}>
          {failure}
        </Text>
      ) : null}
    </>
  );
}

function SyncOn({ info }: { info: FolderInfo | null }) {
  const theme = useTheme();
  const status = useSync((s) => s.status);
  const lastSyncedAt = useSync((s) => s.lastSyncedAt);
  const pending = useSync((s) => s.pending);
  const error = useSync((s) => s.error);
  const types = useSync((s) => s.types);
  const links = useSync((s) => s.profiles);
  const devices = useSync((s) => s.devices);
  const remoteProfiles = useSync((s) => s.remoteProfiles);
  const joining = useSync((s) => s.joining);
  const profiles = useProfiles();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const locked = status === "locked";
  const advanced = async () => {
    const choice = await showMenu([
      { id: "kit", title: t(`Save Recovery Kit…`), symbol: "arrow.down.doc", enabled: !locked },
      { id: "copy", title: t(`Copy Recovery Code`), symbol: "doc.on.doc", enabled: !locked },
      { separator: true },
      { id: "now", title: t(`Sync Now`), symbol: "arrow.triangle.2.circlepath" },
      { id: "reveal", title: `Show Sync Folder in ${PLATFORM_TERMS.fileManager}`, symbol: "folder", enabled: !!info?.exists },
      { separator: true },
      { id: "stop", title: t(`Stop Syncing…`), symbol: "xmark.circle" },
    ]);
    if (choice === "kit") showRecoveryKit();
    else if (choice === "copy") await copyRecoveryPhrase();
    else if (choice === "now") await syncNow();
    else if (choice === "reveal" && info) await revealSyncFolder(info.path);
    else if (choice === "stop") showStopSync();
  };

  const synced = profiles.filter((p) => links[p.id]?.enabled);
  const allTabs = synced.filter((p) => p.syncTabs);
  const shownError = error && status !== "updated" ? error : null;

  return (
    <>
      <SectionHeader title={t(`Sync`)} />
      <Group>
        <Row icon={<SyncIcon on={!locked} />} anchor="general.sync" description={statusLine(status, lastSyncedAt, pending)}>
          {locked ? (
            <Button title={t(`Enter Recovery Phrase…`)} kind="primary" onPress={() => showPhraseEntry(info)} />
          ) : (
            <Button title={t(`Connect Another Device…`)} onPress={showConnectDevice} />
          )}
          <Button title={t(`Advanced…`)} onPress={() => void advanced()} />
        </Row>
        <Row anchor="general.syncFolder" description={info ? folderLabel(info) : " "} />
        <Checklist
          anchor="general.whatSyncs"
          description={null}
          items={[
            ...DATA_TYPES.map((t) => ({ key: t.id, label: t.title, value: types[t.id], onChange: (on: boolean) => setTypeSynced(t.id, on) })),
            {
              key: "allOpenTabs",
              label: t(`All open tabs, not just pinned ones`),
              value: synced.length > 0 && allTabs.length === synced.length,
              mixed: allTabs.length > 0 && allTabs.length < synced.length,
              disabled: !types.tabs || synced.length === 0,
              onChange: (on: boolean) => synced.forEach((p) => setOpenTabsSynced(p.id, on)),
            },
          ]}
        />
        <Row anchor="general.syncDevices" description={devices.length ? undefined : `Just this ${PLATFORM_TERMS.computer} so far. Other devices show here once they sync.`} />
        {devices.map((d) => (
          <Row key={d.id} title={d.current ? `${d.name} (This ${PLATFORM_TERMS.computerTitle})` : d.name} description={d.current ? statusLine(status, lastSyncedAt, 0) : deviceDetail(d, ago)}>
            {d.current ? null : <Button title={t(`Remove…`)} onPress={() => void confirmRemoveDevice(d)} />}
          </Row>
        ))}
      </Group>
      {shownError ? (
        <View style={ERROR_ROW}>
          <Symbol name="exclamationmark.circle.fill" size={11} color={theme.destructive} style={ERROR_ICON} />
          <Text size="caption" tone="textSecondary" style={ERROR_TEXT()}>
            {shownError}
          </Text>
        </View>
      ) : null}
      {joining || remoteProfiles.length ? (
        <>
          <SectionHeader
            title={t(`Profiles on your other devices`)}
            description={joining ? lookingForProfiles(pending) : `Add them to this ${PLATFORM_TERMS.computer}. Choose which profiles sync on each profile's page.`}
            action={remoteProfiles.filter((p) => !p.waiting).length > 1 ? <Button title={t(`Add All`)} onPress={() => addAllRemoteProfiles(remoteProfiles)} /> : undefined}
          />
          {remoteProfiles.length ? (
            <Group>
              {remoteProfiles.map((p) => (
                <RemoteProfileRow key={p.syncId} profile={p} />
              ))}
            </Group>
          ) : null}
        </>
      ) : null}
    </>
  );
}

const SYNC_ICON = 28;
const SYNC_GLYPH = { width: SYNC_ICON, height: SYNC_ICON } as const;
const WARNING_ICON = { width: 28, height: 20 } as const;
const FAILURE = { marginTop: space.m } as const;
const ERROR_ROW = { marginTop: space.m, flexDirection: "row", gap: space.s, paddingHorizontal: space.xxs } as const;
const ERROR_ICON = { width: 14, height: 15 } as const;
const ERROR_TEXT = perLook(() => ({ flex: 1, lineHeight: lineHeight.caption }) as const);
