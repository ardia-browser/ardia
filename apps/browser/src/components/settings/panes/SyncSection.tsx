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
import { chooseSyncFolder, folderInfo, resumeSync, setOpenTabsSynced, setTypeSynced, syncNow, turnOnSync, useSync } from "../../../state/sync/engine";
import { SYNC_PAUSED, SYNC_PAUSED_DETAIL } from "../../../state/sync/syncPause";
import { syncControls } from "../../../state/sync/syncControls";
import { DATA_TYPES, type SyncStatus } from "../../../state/sync/syncDoc";
import { deviceDetail } from "../../../state/sync/devices";
import { Group, Row, SectionHeader } from "../Form";
import { addAllRemoteProfiles, confirmRemoveDevice, folderLabel, lookingForProfiles, RemoteProfileRow, showConnectDevice, showPhraseEntry, showRecoveryKit, showStopSync } from "./SyncSheets";
import { ago } from "../../../lib/time";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { Checklist } from "./Checklist";

function statusLine(status: SyncStatus, lastSyncedAt: number | null, pending: number): string {
  const since = lastSyncedAt ? ago(lastSyncedAt) : null;
  const line = (() => {
    switch (status) {
      case "starting":
        return "Starting up";
      case "updating":
        return "Updating";
      case "offline":
        return "Offline";
      case "paused":
        return since ? `Paused · last synced ${since}` : "Paused";
      case "resuming":
        return "Resuming";
      case "stalled":
      case "locked":
        return since ? `Not syncing · last synced ${since}` : "Not syncing";
      default:
        return since && since !== "just now" ? `Updated ${since}` : "Updated just now";
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
        <SectionHeader title="Sync" />
        <Group>
          <Row anchor="general.sync" description="Sync isn’t available in this build." />
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
      { id: "folder", title: "Choose Sync Folder…" },
      { separator: true },
      ...(hasData ? [{ id: "new", title: "Set Up Without Another Device", enabled: !noICloud }] : []),
      { id: "phrase", title: "Enter Recovery Phrase…" },
    ]);
    if (choice === "folder") void chooseSyncFolder();
    else if (choice === "new") void turnOn();
    else if (choice === "phrase") enterPhrase();
  };
  const where = info ? `Syncs through ${folderLabel(info)}.` : "";

  return (
    <>
      <SectionHeader title="Sync" />
      <Group>
        <Row
          icon={<SyncIcon on={false} />}
          anchor="general.sync"
          description={
            status === "reset" && error
              ? error
              : hasData
                ? "This folder has synced data already. To sync with your other devices, enter the recovery phrase from one of them."
                : `Off. Your ${PLATFORM_TERMS.syncedComputer}s meet in a folder you choose, end-to-end encrypted. ${where}`
          }
        >
          <Button title="More" onPress={() => void otherOptions()} />
          {hasData ? (
            <Button title="Enter Recovery Phrase…" kind="primary" onPress={enterPhrase} />
          ) : (
            <Button title={busy ? "Turning On…" : "Turn On"} kind="primary" disabled={busy || noICloud || !info} onPress={() => void turnOn()} />
          )}
        </Row>
        {noICloud ? (
          <Row
            icon={<Symbol name="exclamationmark.icloud" size={14} color={theme.warning} style={WARNING_ICON} />}
            title={`${PLATFORM_TERMS.cloudDrive} is off on this ${PLATFORM_TERMS.computer}`}
            description={`${PLATFORM_TERMS.turnOnCloudDrive}, or pick any folder that syncs, like Dropbox.`}
          >
            {PLATFORM_TERMS.cloudDriveSettingsUrl ? <Button title="Open iCloud Settings" onPress={() => void Linking.openURL(PLATFORM_TERMS.cloudDriveSettingsUrl)} /> : null}
            <Button title="Choose…" onPress={() => void chooseSyncFolder()} />
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
  const paused = useSync((s) => s.paused);
  const controls = syncControls({ status, paused });
  const advanced = async () => {
    const groups = [
      [
        { id: "kit", title: "Save Recovery Kit…", symbol: "arrow.down.doc", enabled: controls.keyActions },
        { id: "copy", title: "Copy Recovery Code", symbol: "doc.on.doc", enabled: controls.keyActions },
      ],
      [
        { id: "now", title: "Sync Now", symbol: "arrow.triangle.2.circlepath" },
        { id: "reveal", title: `Show Sync Folder in ${PLATFORM_TERMS.fileManager}`, symbol: "folder", enabled: !!info?.exists },
      ],
      [{ id: "stop", title: "Stop Syncing…", symbol: "xmark.circle" }],
    ]
      .map((group) => group.filter((item) => controls.advanced.some((action) => action === item.id)))
      .filter((group) => group.length);
    const choice = await showMenu(groups.flatMap((group, i) => (i ? [{ separator: true } as const, ...group] : group)));
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
      <SectionHeader title="Sync" />
      <Group>
        <Row icon={<SyncIcon on={!locked && !paused} />} anchor="general.sync" description={status === "paused" ? `${SYNC_PAUSED} ${SYNC_PAUSED_DETAIL}` : statusLine(status, lastSyncedAt, pending)}>
          {controls.primary === "resume" ? (
            <Button title={controls.resuming ? "Resuming…" : "Resume"} kind="primary" disabled={controls.resuming} onPress={() => void resumeSync()} />
          ) : controls.primary === "phrase" ? (
            <Button title="Enter Recovery Phrase…" kind="primary" onPress={() => showPhraseEntry(info)} />
          ) : (
            <Button title="Connect Another Device…" onPress={showConnectDevice} />
          )}
          {controls.advanced.length ? <Button title="Advanced…" onPress={() => void advanced()} /> : null}
        </Row>
        <Row anchor="general.syncFolder" description={info ? folderLabel(info) : " "} />
        <Checklist
          anchor="general.whatSyncs"
          description={null}
          items={[
            ...DATA_TYPES.map((t) => ({ key: t.id, label: t.title, value: types[t.id], disabled: !controls.editable, onChange: (on: boolean) => setTypeSynced(t.id, on) })),
            {
              key: "allOpenTabs",
              label: "All open tabs, not just pinned ones",
              value: synced.length > 0 && allTabs.length === synced.length,
              mixed: allTabs.length > 0 && allTabs.length < synced.length,
              disabled: !controls.editable || !types.tabs || synced.length === 0,
              onChange: (on: boolean) => synced.forEach((p) => setOpenTabsSynced(p.id, on)),
            },
          ]}
        />
        <Row anchor="general.syncDevices" description={devices.length ? undefined : paused ? "Your devices show here again once Sync resumes." : `Just this ${PLATFORM_TERMS.computer} so far. Other devices show here once they sync.`} />
        {devices.map((d) => (
          <Row key={d.id} title={d.current ? `${d.name} (This ${PLATFORM_TERMS.computerTitle})` : d.name} description={d.current ? statusLine(status, lastSyncedAt, 0) : deviceDetail(d, ago)}>
            {d.current ? null : <Button title="Remove…" onPress={() => void confirmRemoveDevice(d)} />}
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
            title="Profiles on your other devices"
            description={joining ? lookingForProfiles(pending) : `Add them to this ${PLATFORM_TERMS.computer}. Choose which profiles sync on each profile's page.`}
            action={remoteProfiles.filter((p) => !p.waiting).length > 1 ? <Button title="Add All" onPress={() => addAllRemoteProfiles(remoteProfiles)} /> : undefined}
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
