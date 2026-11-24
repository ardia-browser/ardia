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
import { useLocalPaneRows, useNextFrame, type SavedEntry } from "./savedEntries";
import { PasswordList } from "./PasswordList";
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
import { notePasswordListSearched, notePasswordListShown } from "../../../state/telemetry/exportCounts";
import { useManagerPlugins, useProfilePasswordManager } from "../../../state/site/passwordManager";
import { offerToSaveHandedOver, PasswordManagerRow } from "./PasswordManagerRow";
import { GeneratedPasswordsSection } from "./GeneratedPasswords";
import { ForAllProfilesSection } from "./PasswordManagers";
import { savedLoginsOn, usePaneRows } from "../../../state/vaults/paneRows";
import { loadManagerItems } from "../../../state/vaults/store";
import { vaultsSupported } from "../../../state/vaults/enabled";
import { refreshArdiaManager } from "../../../state/vaults/ardiaManager";
import { VaultLoginSheet } from "../../vaults/VaultLoginSheet";
import { LoginFormSheet, type SavedOn } from "../../vaults/LoginFormSheet";
import { VerificationCodesSection } from "../../vaults/VerificationCodes";
import { PasskeysSection } from "../../vaults/VaultPasskeys";

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

const LOCAL_LIST = !vaultsSupported;

const realmOf = (origin: string) => origin.replace(/\/+$/, "").toLowerCase();

export function PasswordsPage({ profileId }: { profileId: string }) {
  const theme = useTheme();
  const [list, setList] = useState<SavedPassword[] | null>(null);
  const [never, setNever] = useState<string[]>([]);
  const [listQuery, setListQuery] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [reload, setReload] = useState(0);
  const profile = currentEngineProfile(profileId);
  const unlocked = usePasswordsUnlocked(profile);
  const choice = useProfilePasswordManager(profileId);
  const ardia = vaultsSupported && choice === "ardia";
  const shownAsked = useRef(0);
  const searchAsked = useRef<{ query: string; at: number } | null>(null);

  const load = useCallback(() => {
    shownAsked.current = performance.now();
    if (LOCAL_LIST) void listPasswords(profile).catch(orWarn<SavedPassword[]>([])).then(setList);
    else setReload((n) => n + 1);
    void getNeverSavePasswordOrigins(profile).catch(orWarn<string[]>([])).then(setNever);
  }, [profile]);
  useEffect(() => {
    if (unlocked) load();
  }, [unlocked, profileId]);
  useEffect(() => {
    if (unlocked && ardia) void loadManagerItems();
  }, [unlocked, ardia]);

  const local = useLocalPaneRows(LOCAL_LIST ? list : null, listQuery);
  const native = usePaneRows({ enabled: !LOCAL_LIST && unlocked && reload > 0, profile, query: listQuery, managers: ardia, reload });
  const rows = LOCAL_LIST ? local : native;
  useEffect(() => {
    if (!rows.ready) return;
    if (shownAsked.current) {
      notePasswordListShown(rows.listed, performance.now() - shownAsked.current);
      shownAsked.current = 0;
    }
    const asked = searchAsked.current;
    if (asked && asked.query === listQuery) {
      notePasswordListSearched(performance.now() - asked.at);
      searchAsked.current = null;
    }
  }, [rows.ready, rows.key]);
  const typed = useCallback((text: string) => {
    searchAsked.current = text.trim() ? { query: text, at: performance.now() } : null;
  }, []);

  const savedOn = useCallback<SavedOn>(
    (origin) => (LOCAL_LIST ? Promise.resolve((list ?? []).filter((p) => realmOf(p.origin) === realmOf(origin))) : savedLoginsOn(profile, origin)),
    [profile, list],
  );
  const context = useMemo<SheetContext>(() => ({ profile, savedOn, ardia, onChanged: load }), [profile, savedOn, ardia, load]);
  const open = useCallback(
    (entry: SavedEntry) => (entry.saved ? showSaved(entry.saved, context) : showSettingsSheet(<VaultLoginSheet item={entry.item!} site={entry.site} />)),
    [context],
  );
  const newLogin = (mode: "password" | "code") =>
    showSettingsSheet(<LoginFormSheet initialMode={mode} target={{ kind: "new", profileId, savedOn, onSaved: load, onShowExisting: (existing) => showSaved(existing, context) }} />);

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

  const managers = useMemo(() => (ardia ? <ForAllProfilesSection /> : null), [ardia]);
  const transfers = useMemo(
    () => (
      <>
        <SectionHeader title="Passwords" description={`Encrypted on this ${PLATFORM_TERMS.computer}, for this profile only.`} />
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
      </>
    ),
    [importStatus, exportStatus, profile, ardia, load],
  );

  return (
    <ProfileSubPage>
      {managers}
      {transfers}

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
            title={rows.ready ? plural(rows.listed, "Saved Password") : "Saved Passwords"}
            action={
              <Box row gap="s" center>
                {ardia ? <Button variant="icon" icon="plus" size="m" tooltip="New Password" onPress={() => newLogin("password")} /> : null}
                <PasswordSearch onTyped={typed} onSearch={setListQuery} />
              </Box>
            }
          />
          <PasswordList rows={rows} onOpen={open} empty={<Row title={listQuery ? "No passwords match" : "No saved passwords"} />} />
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

function PasswordSearch({ onTyped, onSearch }: { onTyped: (text: string) => void; onSearch: (text: string) => void }) {
  const [text, setText] = useState("");
  const later = useNextFrame(text);
  useEffect(() => onSearch(later), [later]);
  return <SearchField value={text} onChangeText={(t) => (onTyped(t), setText(t))} placeholder="Search" width={200} />;
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
