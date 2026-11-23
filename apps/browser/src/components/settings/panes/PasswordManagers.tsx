import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { VAULT_SETTINGS } from "../../vaults/tokens";
import { effectiveSource, sourceOptions, usePasskeyExtensions } from "../../../state/vaults/passkeySources";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import type { Settings } from "../../../state/settings/settings";
import { VAULT_LOCK_MINUTES } from "../../../state/settings/vaultSettings";
import { KEEP_GENERATED_OPTIONS } from "../../../state/vaults/generated";
import { reloadProviders, type VaultProviderState } from "../../../state/vaults/actions";
import { useVaultBiometricsAvailable, useVaultProviders } from "../../../state/vaults/hooks";
import { useAddingManager, useManagerCatalogue, useOffManagers } from "../../../state/vaults/managerCatalogue";
import { passwordManagersOnly } from "../../../state/vaults/ardia";
import { connectedSavers, preferredSaveTarget } from "../../../state/vaults/saveOffer";
import { refreshVaultSyncStatus, syncedLine, syncVaultsNow, useVaultSync } from "../../../state/vaults/sync";
import { Button, PopUp, Toggle } from "../../ui";
import { changeGuardedVaultSetting } from "../../../state/vaults/settingsGuard";
import { AddingRow, OffRow, ProviderRow, TouchUnlockRow } from "../../vaults/ManagerRows";
import { showAddManagerSheet } from "../../vaults/AddManagerSheet";
import { FieldStack, type StackRow } from "../../vaults/SignInFields";
import { Anchor, Group, Row, SectionHeader } from "../Form";
import type { SettingId } from "../settingsIndex";
import { passwordManagerAnchor } from "../../../state/plugins/passwordManagerLink";
import { showConnectSheet, showUnlockSheet } from "./PasswordManagerSheets";
import { VaultICloudRows } from "./VaultICloudRows";
import { VaultSuggestRow } from "./VaultSuggestRow";

const LOCK_TITLES: Record<(typeof VAULT_LOCK_MINUTES)[number], string> = { 5: "5 Minutes", 15: "15 Minutes", 30: "30 Minutes", 60: "1 Hour", 0: "Never" };
const LOCK_OPTIONS = VAULT_LOCK_MINUTES.map((m) => ({ value: String(m), title: LOCK_TITLES[m] }));
const ASK = "ask";

const OWNER_CHECK_REFUSED = "Confirm it's you to change this setting.";
const REFUSED_NOTE_MS = 4000;

export function useOwnerCheckNote() {
  const [refused, setRefused] = useState(0);
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => setRefused(0), REFUSED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [refused]);
  const guard = async (change: () => Promise<boolean>) => {
    setRefused(0);
    if (!(await change())) setRefused(Date.now());
  };
  return { note: refused ? OWNER_CHECK_REFUSED : undefined, guard };
}

type GuardedSwitch = keyof Pick<Settings, "vaultAskBeforeFilling" | "vaultLockOnScreenLock" | "vaultLockOnQuit">;

function GuardedToggle({ title, setting }: { title: string; setting: GuardedSwitch }) {
  const value = useSettings((s) => s[setting]);
  const { note, guard } = useOwnerCheckNote();
  return (
    <Row title={title} description={note}>
      <Toggle value={value} accessibilityLabel={title} onChange={(on) => void guard(() => changeGuardedVaultSetting({ [setting]: on }))} />
    </Row>
  );
}

type PlainSwitch = keyof Pick<Settings, "vaultMenuGlass" | "vaultSaveOffer" | "vaultAutoSave">;

function SettingSwitch({ title, setting }: { title: string; setting: PlainSwitch }) {
  const value = useSettings((s) => s[setting]);
  return (
    <Row title={title}>
      <Toggle value={value} accessibilityLabel={title} onChange={(on) => updateSettings({ [setting]: on })} />
    </Row>
  );
}

function LockAfterRow() {
  const lockAfter = useSettings((s) => s.vaultIdleLockMinutes);
  const { note, guard } = useOwnerCheckNote();
  return (
    <Row title="Lock after" description={note}>
      <PopUp value={String(lockAfter)} options={LOCK_OPTIONS} onChange={(v) => void guard(() => changeGuardedVaultSetting({ vaultIdleLockMinutes: Number(v) }))} />
    </Row>
  );
}

function ManagersGroup({ managers }: { managers: VaultProviderState[] }) {
  const adding = useAddingManager();
  const catalogue = useManagerCatalogue();
  const off = useOffManagers();
  const sheets = { connect: (id: string) => showConnectSheet(id), unlock: (id: string) => showUnlockSheet(id) };
  const shown = adding && !managers.some((p) => p.id === adding.name) ? adding : null;
  const rows: StackRow[] = [
    ...managers.map((p) => ({ key: p.id, render: () => <ManagerAnchor name={p.plugin ?? p.id}><ProviderRow provider={p} sheets={sheets} /></ManagerAnchor> })),
    ...off.filter((e) => e.name !== shown?.name).map((e) => ({ key: `off-${e.name}`, render: () => <ManagerAnchor name={e.name}><OffRow entry={e} sheets={sheets} /></ManagerAnchor> })),
    ...(shown ? [{ key: `adding-${shown.name}`, render: () => <AddingRow adding={shown} onReady={sheets.connect} /> }] : []),
  ];
  const syncs = managers.some((p) => p.state === "unlocked");
  if (syncs) rows.push({ key: "sync", render: () => <SyncRow providers={managers} /> });
  const canAdd = catalogue.some((e) => e.name !== adding?.name);
  if (!rows.length && !canAdd) return null;
  const add = (
    <View pointerEvents={canAdd ? "auto" : "none"} accessibilityElementsHidden={!canAdd} importantForAccessibility={canAdd ? "auto" : "no-hide-descendants"} style={canAdd ? undefined : HELD_PLACE}>
      <Button title="Add Password Manager…" disabled={!canAdd || adding?.phase === "installing" || adding?.phase === "starting"} onPress={() => showAddManagerSheet(sheets.connect)} />
    </View>
  );
  return (
    <View>
      <SectionHeader title="Password Managers" description={null} action={add} />
      {rows.length ? <FieldStack rows={rows} gap={false} inSheet={false} /> : null}
    </View>
  );
}

const HELD_PLACE = { opacity: 0 } as const;

function ManagerAnchor({ name, children }: { name: string; children: ReactNode }) {
  return (
    <Anchor id={passwordManagerAnchor(name) as SettingId} shape="row">
      {children}
    </Anchor>
  );
}

const SYNC_TITLES = { idle: "Sync Now", syncing: "Syncing…", synced: "Synced", failed: "Try Again" } as const;
const SYNC_RESERVE = Object.values(SYNC_TITLES);
const SYNC_FAILED = "Couldn't sync. Check your connection and try again.";

const isConnected = (p: VaultProviderState) => p.state === "unlocked" || p.state === "locked";

function SyncRow({ providers }: { providers: VaultProviderState[] }) {
  const phase = useVaultSync((s) => s.phase);
  const syncedAt = useVaultSync((s) => s.syncedAt);
  const failed = useVaultSync((s) => s.failed);
  useEffect(() => void refreshVaultSyncStatus(), []);
  const names = providers.filter((p) => failed.includes(p.id)).map((p) => p.name);
  const description = phase !== "failed" ? syncedLine(syncedAt, Date.now()) : names.length ? `${names.join(", ")} didn't sync. Try again in a moment.` : SYNC_FAILED;
  return (
    <Row title="Sync" description={description}>
      <Button title={SYNC_TITLES[phase]} reserve={SYNC_RESERVE} disabled={phase === "syncing"} onPress={() => void syncVaultsNow()} />
    </Row>
  );
}

export function ForAllProfilesSection() {
  const providers = useVaultProviders();
  const saveTarget = useSettings((s) => s.vaultSaveTarget);
  const saveOffer = useSettings((s) => s.vaultSaveOffer);
  const keepGenerated = useSettings((s) => s.vaultKeepGenerated);
  const passkeySetting = useSettings((s) => s.vaultPasskeySource);
  const passkeyExtensions = usePasskeyExtensions();
  useEffect(() => void reloadProviders(), []);
  const managers = passwordManagersOnly(providers);
  const savers = connectedSavers(providers);
  const targetOptions = [...(savers.length === 1 ? [] : [{ value: ASK, title: "Ask Each Time" }]), ...savers.map((p) => ({ value: p.id, title: p.name }))];
  const target = preferredSaveTarget(providers, saveTarget) || ASK;
  const fills = providers.some(isConnected);
  const touchID = useVaultBiometricsAvailable() && managers.some((p) => isConnected(p) && p.capabilities.touchID);
  return (
    <View>
      <ManagersGroup managers={managers} />
      <SectionHeader title="For All Profiles" description={null} />
      <View>
        <Group>
          {fills ? <VaultSuggestRow /> : null}
          {fills ? <GuardedToggle title="Ask before filling" setting="vaultAskBeforeFilling" /> : null}
          {fills ? <SettingSwitch title="Translucent password menu" setting="vaultMenuGlass" /> : null}
          {savers.length ? <SettingSwitch title="Offer to save new logins" setting="vaultSaveOffer" /> : null}
          {savers.length && saveOffer ? <SettingSwitch title="Save new passwords automatically" setting="vaultAutoSave" /> : null}
          {savers.length ? (
            <Row title="Save new logins to">
              <PopUp value={target} options={targetOptions} minWidth={VAULT_SETTINGS.savePopUp} onChange={(v) => updateSettings({ vaultSaveTarget: v === ASK ? "" : v })} />
            </Row>
          ) : null}
          {passkeyExtensions.length ? (
            <Row title="Use passkeys from" description="Which app answers when a site asks for a passkey.">
              <PopUp
                value={effectiveSource(passkeySetting, passkeyExtensions)}
                options={sourceOptions(passkeyExtensions)}
                minWidth={VAULT_SETTINGS.sourcePopUp}
                onChange={(v) => updateSettings({ vaultPasskeySource: v })}
              />
            </Row>
          ) : null}
          <LockAfterRow />
          <GuardedToggle title="Lock when screen locks" setting="vaultLockOnScreenLock" />
          <GuardedToggle title="Lock when Ardia quits" setting="vaultLockOnQuit" />
          {touchID ? <TouchUnlockRow /> : null}
          <Row title="Keep generated passwords">
            <PopUp value={String(keepGenerated)} options={KEEP_GENERATED_OPTIONS} onChange={(v) => updateSettings({ vaultKeepGenerated: Number(v) })} />
          </Row>
          <VaultICloudRows />
        </Group>
      </View>
    </View>
  );
}

