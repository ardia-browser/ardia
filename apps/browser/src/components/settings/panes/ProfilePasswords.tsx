import {
  exportPasswords,
  getNeverSavePasswordOrigins,
  listPasswords,
  setNeverSavePasswords,
  type PasswordExportStatus,
  type SavedPassword,
} from "../../../state/site/passwords";
import { orWarn } from "../../../lib/fallback";
import { systemInfo } from "../../../state/app/system";
import { Box, Button, SearchField, Symbol, Text, Toggle } from "../../ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTheme } from "../../ui/theme";
import { currentEngineProfile } from "../../../state/browser/current";
import { plural } from "../../../state/browser/model";
import { importPasswordsCsv, unlockPasswordsFor, usePasswordsUnlocked } from "../../../state/site/savedPasswords";
import { hostLabel } from "../../pages/PageLayout";
import { showSaved, type SheetContext } from "./PasswordSheets";
import { loginEntries, mergeSorted, savedEntries, useNarrowedEntries, useNextFrame, type SavedEntry } from "./savedEntries";
import { Favicon } from "../../favicon/Favicon";
import { Group, Row, SectionHeader } from "../Form";
import { keptByExtensionNote } from "../keptByExtension";
import { settingsLayout } from "../tokens";
import { autofillEnabled, autofillToggleAsked, passwordAutofill, setAutofillFor, setPasswordAutofillFor } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { showSettingsSheet } from "../../../state/settings/sheet";
import { goToSettingsPane, SETTINGS_DETAIL } from "../../../state/settings/settingsWindows";
import { ProfileSubPage } from "./ProfileSubPage";
import { useGrowingRows } from "../../../state/settings/growingRows";
import { notePasswordListShown } from "../../../state/telemetry/exportCounts";
import { useManagerPlugins, useProfilePasswordManager } from "../../../state/site/passwordManager";
import { offerToSaveHandedOver, PasswordManagerRow } from "./PasswordManagerRow";
import { GeneratedPasswordsSection } from "./GeneratedPasswords";
import { ForAllProfilesSection } from "./PasswordManagers";
import { useVaultLogins } from "../../../state/vaults/hooks";
import { loadManagerItems } from "../../../state/vaults/store";
import { vaultsSupported } from "../../../state/vaults/enabled";
import { refreshArdiaManager } from "../../../state/vaults/ardiaManager";
import { brandOf } from "../../../state/vaults/brands";
import { BrandBadge } from "../../vaults/VaultParts";
import { VaultLoginSheet } from "../../vaults/VaultLoginSheet";
import { LoginFormSheet } from "../../vaults/LoginFormSheet";
import { VerificationCodesSection } from "../../vaults/VerificationCodes";
import { PasskeysSection } from "../../vaults/VaultPasskeys";
import { VAULT_SETTINGS } from "../../vaults/tokens";

function passwordManagerAppsNote() {
  return systemInfo().inApplicationsFolder === false
    ? "For 1Password, move Ardia to Applications, then add it in its Settings › Browser."
    : "Their extensions work here. For 1Password, add Ardia in its Settings › Browser.";
}

export function PasswordsSection({ profileId }: { profileId: string }) {
  const profile = currentEngineProfile(profileId);
  const [autofill = true] = useResource(passwordAutofill, profile);
  const [passwordsAsked] = useResource(autofillToggleAsked, profile, "passwords");
  const [enabled] = useResource(autofillEnabled, profile);
  const [addressesAsked] = useResource(autofillToggleAsked, profile, "addresses");
  const [cardsAsked] = useResource(autofillToggleAsked, profile, "cards");
  const open = (detail: string) => goToSettingsPane("profiles", profileId, detail);
  const handedOver = offerToSaveHandedOver(useProfilePasswordManager(profileId), useManagerPlugins());

  return (
    <>
      <SectionHeader title="Passwords and autofill" />
      <Group>
        <PasswordManagerRow profileId={profileId} />
        <Row anchor="profiles.offerToSavePasswords" description={handedOver ?? keptByExtensionNote(autofill, passwordsAsked)}>
          <Toggle value={!handedOver && autofill} disabled={!!handedOver} onChange={(v) => void setPasswordAutofillFor(profile, v).then(() => void (vaultsSupported && refreshArdiaManager()))} />
        </Row>
        <Row anchor="profiles.passwords" onPress={() => open(SETTINGS_DETAIL.passwords)} />
        <Row anchor="profiles.addresses" description={keptByExtensionNote(enabled?.addresses, addressesAsked)}>
          <Toggle value={enabled?.addresses ?? true} disabled={!enabled} onChange={(v) => setAutofillFor(profile, "addresses", v)} />
        </Row>
        <Row anchor="profiles.savedAddresses" onPress={() => open(SETTINGS_DETAIL.addresses)} />
        <Row anchor="profiles.cards" description={keptByExtensionNote(enabled?.cards, cardsAsked)}>
          <Toggle value={enabled?.cards ?? true} disabled={!enabled} onChange={(v) => setAutofillFor(profile, "cards", v)} />
        </Row>
        <Row anchor="profiles.savedCards" onPress={() => open(SETTINGS_DETAIL.cards)} />
      </Group>
    </>
  );
}

function savedRow(entry: SavedEntry, context: SheetContext) {
  return (
    <Row
      key={entry.key}
      icon={entry.url ? <Favicon url={entry.url} size={VAULT_SETTINGS.siteIcon} /> : <BrandBadge provider={entry.item?.provider ?? ""} />}
      title={entry.site}
      description={entry.username || "No username"}
      onPress={() => (entry.saved ? showSaved(entry.saved, context) : showSettingsSheet(<VaultLoginSheet item={entry.item!} site={entry.site} />))}
    >
      {entry.item ? <BrandBadge provider={entry.item.provider} tooltip={brandOf(entry.item.provider).name} /> : null}
    </Row>
  );
}

export function PasswordsPage({ profileId }: { profileId: string }) {
  const theme = useTheme();
  const [list, setList] = useState<SavedPassword[] | null>(null);
  const [never, setNever] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const profile = currentEngineProfile(profileId);
  const unlocked = usePasswordsUnlocked(profile);
  const choice = useProfilePasswordManager(profileId);
  const ardia = vaultsSupported && choice === "ardia";
  const logins = useVaultLogins({ enabled: ardia, managersOnly: true });
  const arrived = useRef(0);

  const load = useCallback(() => {
    void listPasswords(profile)
      .catch(orWarn<SavedPassword[]>([]))
      .then((passwords) => {
        arrived.current = performance.now();
        setList(passwords);
      });
    void getNeverSavePasswordOrigins(profile).catch(orWarn<string[]>([])).then(setNever);
  }, [profile]);
  useEffect(() => {
    if (unlocked) load();
  }, [unlocked, profileId]);
  useEffect(() => {
    if (unlocked && ardia) void loadManagerItems();
  }, [unlocked, ardia]);
  useEffect(() => {
    if (!list || !arrived.current) return;
    notePasswordListShown(list.length, performance.now() - arrived.current);
    arrived.current = 0;
  }, [list]);

  const importCsv = async () => {
    try {
      const result = await importPasswordsCsv(profile);
      if (result === "cancelled") return;
      const skipped = result.skipped ? ` ${plural(result.skipped, "login")} couldn't be saved.` : "";
      setImportStatus(`Imported ${plural(result.saved, "password")}.${skipped}`);
      load();
      if (ardia) void refreshArdiaManager();
    } catch (e) {
      setImportStatus(`Couldn't import that file: ${(e as Error).message}`);
    }
  };

  const exportCsv = async () => {
    const { status, path } = await exportPasswords(profile).catch(orWarn<{ status: PasswordExportStatus; path?: string }>({ status: "writeFailed" }));
    const folder = path ? path.split(/[\\/]/).slice(-2, -1)[0] : "";
    if (status === "succeeded") setExportStatus(`Saved to “${folder}”. Delete the file once you're done with it.`);
    else if (status === "writeFailed") setExportStatus("Couldn't write the file. Try another folder.");
    else if (status === "inProgress") setExportStatus("An export is already running.");
    else setExportStatus("");
  };

  const saved = useMemo(() => savedEntries(list ?? []), [list]);
  const fromManagers = useMemo(() => (ardia ? loginEntries(logins) : []), [ardia, logins]);
  const entries = useMemo(() => mergeSorted(saved, fromManagers), [saved, fromManagers]);
  const listQuery = useNextFrame(query);
  const shown = useNarrowedEntries(entries, listQuery);
  const rows = useGrowingRows(shown.length, `${profile}|${listQuery}`);
  const context = useMemo<SheetContext>(() => ({ profile, list: list ?? [], ardia, onChanged: load }), [profile, list, ardia, load]);
  const newLogin = (mode: "password" | "code") =>
    showSettingsSheet(
      <LoginFormSheet initialMode={mode} target={{ kind: "new", profileId, saved: list ?? [], onSaved: load, onShowExisting: (existing) => showSaved(existing, context) }} />,
    );

  return (
    <ProfileSubPage>
      {ardia ? <ForAllProfilesSection /> : null}
      <SectionHeader
        title="Passwords"
        description={`Encrypted on this ${PLATFORM_TERMS.computer}, for this profile only.`}
      />
      <Group>
        <Row title="Import passwords" description={importStatus || "From a CSV exported by Chrome, Safari, Firefox, 1Password, Bitwarden…"}>
          <Button title="Import CSV…" onPress={() => void importCsv()} />
        </Row>
        {PLATFORM_FEATURES.exportsBookmarksAndPasswords ? (
          <Row title="Export passwords" description={exportStatus || "To a CSV file. Anyone who can open the file can read your passwords."}>
            <Button title="Export CSV…" onPress={() => void exportCsv()} />
          </Row>
        ) : null}
        <Row title="Password manager apps" description={passwordManagerAppsNote()} />
      </Group>

      {!unlocked ? (
        <Box gap="ml" style={LOCKED}>
          <Symbol name="lock.fill" size={26} color={theme.textTertiary} style={LOCK_ICON} />
          <Text size="title" weight="medium">
            Passwords are locked
          </Text>
          <Text size="small" tone="textSecondary">
            {`Unlock with ${PLATFORM_TERMS.deviceUnlock} to see them.`}
          </Text>
          <Button title="Unlock" kind="primary" onPress={() => void unlockPasswordsFor(profile)} />
        </Box>
      ) : (
        <>
          <SectionHeader
            title={list ? plural(entries.length, "Saved Password") : "Saved Passwords"}
            action={
              <Box row gap="s" center>
                {ardia ? <Button variant="icon" icon="plus" size="m" tooltip="New Password" onPress={() => newLogin("password")} /> : null}
                <SearchField value={query} onChangeText={setQuery} placeholder="Search" width={200} />
              </Box>
            }
          />
          <Group>{list && shown.length === 0 ? <Row title={listQuery ? "No passwords match" : "No saved passwords"} /> : shown.slice(0, rows).map((e) => savedRow(e, context))}</Group>
          {ardia ? <ArdiaExtras query={listQuery} profile={profile} onNewCode={() => newLogin("code")} /> : null}
          {never.length > 0 && (
            <>
              <SectionHeader title="Never Saved" description="Sites where you chose “Never on This Site”." />
              <Group>
                {never.map((origin) => (
                  <Row key={origin} icon={<Favicon url={origin} />} title={hostLabel(origin)}>
                    <Button title="Remove" onPress={() => void setNeverSavePasswords(profile, origin, false).catch(orWarn(undefined)).then(load)} />
                  </Row>
                ))}
              </Group>
            </>
          )}
        </>
      )}
    </ProfileSubPage>
  );
}

function ArdiaExtras({ query, profile, onNewCode }: { query: string; profile: string; onNewCode: () => void }): ReactNode {
  return (
    <>
      <GeneratedPasswordsSection query={query} profile={profile} />
      <PasskeysSection query={query} />
      <VerificationCodesSection query={query} onAdd={onNewCode} />
    </>
  );
}

const LOCKED = { alignItems: "center", marginTop: settingsLayout.emptyTop } as const;
const LOCK_ICON = { width: 36, height: 36 } as const;
