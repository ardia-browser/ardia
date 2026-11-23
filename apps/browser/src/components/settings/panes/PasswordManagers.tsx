import { useEffect, useState } from "react";
import { View } from "react-native";
import { VAULT_SETTINGS } from "../../vaults/tokens";
import { effectiveSource, sourceOptions, usePasskeyExtensions } from "../../../state/vaults/passkeySources";
import { confirm, showMenu } from "../../../state/app/system";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import type { Settings } from "../../../state/settings/settings";
import { VAULT_LOCK_MINUTES } from "../../../state/settings/vaultSettings";
import { KEEP_GENERATED_OPTIONS } from "../../../state/vaults/generated";
import { lockProvider, reloadProviders, signInError, signOutProvider, unlockProvider, type VaultProviderState } from "../../../state/vaults/actions";
import { exportManagerPasswords } from "../../../state/vaults/export";
import { useVaultProviders } from "../../../state/vaults/hooks";
import { passwordManagersOnly } from "../../../state/vaults/ardia";
import { connectedSavers, preferredSaveTarget } from "../../../state/vaults/saveOffer";
import { refreshVaultSyncStatus, syncedLine, syncVaultsNow, useVaultSync } from "../../../state/vaults/sync";
import { Box, Button, PopUp, space, Toggle } from "../../ui";
import { changeGuardedVaultSetting } from "../../../state/vaults/settingsGuard";
import { BrandBadge } from "../../vaults/VaultParts";
import { Group, Row, SectionHeader } from "../Form";
import { showConnectSheet, showUnlockSheet, UNLOCK_TITLES } from "./PasswordManagerSheets";
import { VaultICloudRows } from "./VaultICloudRows";
import { VaultSuggestRow } from "./VaultSuggestRow";

const LOCK_TITLES: Record<(typeof VAULT_LOCK_MINUTES)[number], string> = { 5: "5 Minutes", 15: "15 Minutes", 30: "30 Minutes", 60: "1 Hour", 0: "Never" };
const LOCK_OPTIONS = VAULT_LOCK_MINUTES.map((m) => ({ value: String(m), title: LOCK_TITLES[m] }));
const ASK = "ask";

const SHORT_MESSAGE = 60;

const unavailableLine = (message: string | null | undefined) => (message && message.length <= SHORT_MESSAGE ? message : "Unavailable");

function stateLine(p: VaultProviderState): string | undefined {
  const account = [p.account, p.server && p.capabilities.selfHosted ? p.server.replace(/^https?:\/\//, "") : null].filter(Boolean).join(" · ");
  const status = p.state === "locked" ? "Locked" : p.state === "notInstalled" ? "Not Installed" : p.state === "unavailable" ? unavailableLine(p.message) : p.state === "signedOut" ? "Not Connected" : "";
  return [account, status].filter(Boolean).join(" · ") || undefined;
}

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

function ProviderRow({ provider }: { provider: VaultProviderState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const unlock = async () => {
    setBusy(true);
    setError("");
    const result = await unlockProvider(provider.id, null);
    setBusy(false);
    if (result.needs === "password") return showUnlockSheet(provider.id);
    if (!result.ok) setError(signInError(result, provider.name));
  };
  const more = async () => {
    const choice = await showMenu([
      ...(provider.state === "unlocked" ? [{ id: "lock", title: "Lock", symbol: "lock" }] : []),
      ...(provider.state === "unlocked" && PLATFORM_FEATURES.exportsBookmarksAndPasswords ? [{ id: "export", title: "Export Passwords…", symbol: "square.and.arrow.up" }] : []),
      { separator: true },
      { id: "signOut", title: "Sign Out…", symbol: "rectangle.portrait.and.arrow.right" },
    ]);
    if (choice === "lock") await lockProvider(provider.id);
    if (choice === "export") setError(await exportManagerPasswords(provider.id));
    if (choice !== "signOut") return;
    const { confirmed } = await confirm({ title: `Sign Out of ${provider.name}?`, message: "Ardia won't fill from it until you connect again.", confirmTitle: "Sign Out" });
    if (confirmed) await signOutProvider(provider.id);
  };
  return (
    <Row icon={<BrandBadge provider={provider.id} size="m" />} title={provider.name} description={error || stateLine(provider)}>
      <Box row gap="s" center>
        {provider.state === "locked" ? <Button title={busy ? "Unlocking…" : "Unlock"} reserve={UNLOCK_TITLES} disabled={busy} onPress={() => void unlock()} /> : null}
        {isConnected(provider) ? (
          <Button variant="icon" icon="ellipsis.circle" size="l" tooltip="More" onPress={() => void more()} />
        ) : (
          <Button title="Connect…" onPress={() => showConnectSheet(provider.id)} />
        )}
      </Box>
    </Row>
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
  const syncs = managers.some((p) => p.state === "unlocked");
  return (
    <View>
      <SectionHeader title="For All Profiles" description={null} />
      {managers.length ? (
        <Group>
          {managers.map((p) => (
            <ProviderRow key={p.id} provider={p} />
          ))}
          {syncs ? <SyncRow providers={managers} /> : null}
        </Group>
      ) : null}
      <View style={managers.length ? GROUP_GAP : null}>
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
          <Row title="Keep generated passwords">
            <PopUp value={String(keepGenerated)} options={KEEP_GENERATED_OPTIONS} onChange={(v) => updateSettings({ vaultKeepGenerated: Number(v) })} />
          </Row>
          <VaultICloudRows />
        </Group>
      </View>
    </View>
  );
}

const GROUP_GAP = { marginTop: space.l } as const;
