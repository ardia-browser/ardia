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
import { chooseSyncFolder, folderInfo, moveSyncFolder, setOpenTabsSynced, setSyncFolder, setTypeSynced, syncNow, turnOnSync, useSync } from "../../../state/sync/engine";
import { folderMoveMessage, pickSyncFolder, type TurnOnFolder } from "../../../state/sync/folderMove";
import { DATA_TYPES, type SyncStatus } from "../../../state/sync/syncDoc";
import { deviceDetail } from "../../../state/sync/devices";
import { Group, Row, SectionHeader } from "../Form";
import { addAllRemoteProfiles, confirmRemoveDevice, folderLabel, lookingForProfiles, RemoteProfileRow, showConnectDevice, showPhraseEntry, showRecoveryKit, showStopSync } from "./SyncSheets";
import { ago } from "../../../lib/time";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
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
  const chosen = useSync((s) => s.folder);
  const asksWhere = !PLATFORM_FEATURES.defaultCloudDrive && !chosen && !info?.hasSyncData;
  const noICloud = !asksWhere && !!info && info.path === info.defaultPath && !info.iCloudAvailable;
  const hasData = !!info?.hasSyncData;

  const turnOn = async (path = info?.path, how: TurnOnFolder | undefined = PLATFORM_FEATURES.defaultCloudDrive ? undefined : "kept") => {
    if (!path) return;
    setBusy(true);
    setFailure(null);
    const result = await turnOnSync(path, how);
    setBusy(false);
    if ("error" in result) setFailure(result.error);
    else showRecoveryKit();
  };
  const pickThenEnter = async () => {
    const picked = await chooseSyncFolder();
    if (picked) showPhraseEntry(await folderInfo(picked), () => void pickThenEnter());
  };
  const turnOnAsking = async () => {
    setFailure(null);
    const picked = await pickSyncFolder(null);
    if (!picked) return;
    const picks = await folderInfo(picked);
    if (!picks?.hasSyncData) return turnOn(picked, "picked");
    await setSyncFolder(picked);
    showPhraseEntry(picks, () => void pickThenEnter());
  };
  const enterPhrase = () =>
    asksWhere ? void pickThenEnter() : showPhraseEntry(info, () => void chooseSyncFolder().then(() => folderInfo().then((i) => showPhraseEntry(i))));
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
                : asksWhere
                  ? `Off. Your ${PLATFORM_TERMS.syncedComputer}s meet in a folder you choose, end-to-end encrypted. Turn On asks where: pick one that ${PLATFORM_TERMS.cloudDrive} keeps in sync, or one on a shared drive, and Ardia keeps its files in an “Ardia Sync” folder there.`
                  : `Off. Your ${PLATFORM_TERMS.syncedComputer}s meet in a folder you choose, end-to-end encrypted. ${where}`
          }
        >
          <Button title="More" onPress={() => void otherOptions()} />
          {hasData ? (
            <Button title="Enter Recovery Phrase…" kind="primary" onPress={enterPhrase} />
          ) : (
            <Button
              title={busy ? "Turning On…" : asksWhere ? "Turn On…" : "Turn On"}
              kind="primary"
              disabled={busy || noICloud || !info}
              onPress={() => void (asksWhere ? turnOnAsking() : turnOn())}
            />
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
  const [moved, setMoved] = useState<{ text: string; failed: boolean } | null>(null);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const locked = status === "locked";
  const move = async () => {
    if (!info) return;
    setMoved(null);
    const target = await pickSyncFolder(info.path);
    if (!target) return;
    const result = await moveSyncFolder(target);
    const label = folderLabel({ path: target, inICloud: false });
    setMoved({ text: folderMoveMessage(result, label, folderLabel(info)), failed: "error" in result });
  };
  const advanced = async () => {
    const choice = await showMenu([
      { id: "kit", title: "Save Recovery Kit…", symbol: "arrow.down.doc", enabled: !locked },
      { id: "copy", title: "Copy Recovery Code", symbol: "doc.on.doc", enabled: !locked },
      { separator: true },
      { id: "now", title: "Sync Now", symbol: "arrow.triangle.2.circlepath" },
      { id: "reveal", title: `Show Sync Folder in ${PLATFORM_TERMS.fileManager}`, symbol: "folder", enabled: !!info?.exists },
      ...(PLATFORM_FEATURES.movesSyncFolder ? [{ id: "move", title: "Move Sync Folder…", symbol: "arrow.right.circle", enabled: !locked && !!info }] : []),
      { separator: true },
      { id: "stop", title: "Stop Syncing…", symbol: "xmark.circle" },
    ]);
    if (choice === "kit") showRecoveryKit();
    else if (choice === "copy") await copyRecoveryPhrase();
    else if (choice === "now") await syncNow();
    else if (choice === "reveal" && info) await revealSyncFolder(info.path);
    else if (choice === "move") await move();
    else if (choice === "stop") showStopSync();
  };

  const synced = profiles.filter((p) => links[p.id]?.enabled);
  const allTabs = synced.filter((p) => p.syncTabs);
  const shownError = error && status !== "updated" ? error : null;

  return (
    <>
      <SectionHeader title="Sync" />
      <Group>
        <Row icon={<SyncIcon on={!locked} />} anchor="general.sync" description={statusLine(status, lastSyncedAt, pending)}>
          {locked ? (
            <Button title="Enter Recovery Phrase…" kind="primary" onPress={() => showPhraseEntry(info)} />
          ) : (
            <Button title="Connect Another Device…" onPress={showConnectDevice} />
          )}
          <Button title="Advanced…" onPress={() => void advanced()} />
        </Row>
        <Row anchor="general.syncFolder" description={info ? folderLabel(info) : " "}>
          {PLATFORM_FEATURES.movesSyncFolder ? <Button title="Move…" disabled={locked || !info} onPress={() => void move()} /> : null}
        </Row>
        <Checklist
          anchor="general.whatSyncs"
          description={null}
          items={[
            ...DATA_TYPES.map((t) => ({ key: t.id, label: t.title, value: types[t.id], onChange: (on: boolean) => setTypeSynced(t.id, on) })),
            {
              key: "allOpenTabs",
              label: "All open tabs, not just pinned ones",
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
            {d.current ? null : <Button title="Remove…" onPress={() => void confirmRemoveDevice(d)} />}
          </Row>
        ))}
      </Group>
      {moved ? (
        <Text size="caption" tone={moved.failed ? "destructive" : "textSecondary"} style={FAILURE}>
          {moved.text}
        </Text>
      ) : null}
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
