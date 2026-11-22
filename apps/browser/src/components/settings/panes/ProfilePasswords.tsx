import {
  deletePassword,
  exportPasswords,
  getNeverSavePasswordOrigins,
  listPasswords,
  setNeverSavePasswords,
  updatePassword,
  type PasswordExportStatus,
  type SavedPassword,
} from "../../../state/site/passwords";
import { orWarn } from "../../../lib/fallback";
import { confirm, copyText, systemInfo } from "../../../state/app/system";
import { Box, Button, DialogActions, DialogTitle, SearchField, Sheet, space, Symbol, Text, TextField, Toggle } from "../../ui";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useTheme } from "../../ui/theme";
import { monoFace } from "../../ui/tokens";
import { currentEngineProfile } from "../../../state/browser/current";
import { plural } from "../../../state/browser/model";
import { importPasswordsCsv, revealPassword, unlockPasswordsFor, usePasswordsUnlocked } from "../../../state/site/savedPasswords";
import { hostLabel, matchesQuery } from "../../pages/PageLayout";
import { Favicon } from "../../favicon/Favicon";
import { Group, Row, SectionHeader } from "../Form";
import { keptByExtensionNote } from "../keptByExtension";
import { settingsLayout } from "../tokens";
import { autofillEnabled, autofillToggleAsked, passwordAutofill, setAutofillFor, setPasswordAutofillFor } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { goToSettingsPane, SETTINGS_DETAIL } from "../../../state/settings/settingsWindows";
import { ProfileSubPage } from "./ProfileSubPage";
import { useGrowingRows } from "../../../state/settings/growingRows";
import { notePasswordListShown } from "../../../state/telemetry/exportCounts";
import { useManagerPlugins, useProfilePasswordManager } from "../../../state/site/passwordManager";
import { offerToSaveHandedOver, PasswordManagerRow } from "./PasswordManagerRow";
import { t } from "../../../lib/uiLanguage";


function passwordManagerAppsNote() {
  const apps = `1Password, Bitwarden, KeePassXC and Proton Pass extensions connect to their ${PLATFORM_TERMS.computer} apps.`;
  return systemInfo().inApplicationsFolder === false
    ? `${apps} For 1Password, move Ardia to your Applications folder and reopen it (1Password only connects to browsers there), then in the 1Password app open Settings › Browser › Add Browser and choose it.`
    : `${apps} For 1Password, add Ardia once: in the 1Password app, open Settings › Browser › Add Browser and choose Ardia.`;
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
      <SectionHeader title={t(`Passwords and autofill`)} />
      <Group>
        <PasswordManagerRow profileId={profileId} />
        <Row anchor="profiles.offerToSavePasswords" description={handedOver ?? keptByExtensionNote(autofill, passwordsAsked)}>
          <Toggle value={!handedOver && autofill} disabled={!!handedOver} onChange={(v) => setPasswordAutofillFor(profile, v)} />
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

export function PasswordsPage({ profileId }: { profileId: string }) {
  const theme = useTheme();
  const [list, setList] = useState<SavedPassword[] | null>(null);
  const [never, setNever] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const profile = currentEngineProfile(profileId);
  const unlocked = usePasswordsUnlocked(profile);
  const arrived = useRef(0);

  const load = () => {
    void listPasswords(profile)
      .catch(orWarn<SavedPassword[]>([]))
      .then((passwords) => {
        arrived.current = performance.now();
        setList(passwords);
      });
    void getNeverSavePasswordOrigins(profile).catch(orWarn<string[]>([])).then(setNever);
  };
  useEffect(() => {
    if (unlocked) load();
  }, [unlocked, profileId]);
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
    } catch (e) {
      setImportStatus(`Couldn't import that file: ${(e as Error).message}`);
    }
  };

  const exportCsv = async () => {
    const { status, path } = await exportPasswords(profile).catch(orWarn<{ status: PasswordExportStatus; path?: string }>({ status: "writeFailed" }));
    const folder = path ? path.split(/[\\/]/).slice(-2, -1)[0] : "";
    if (status === "succeeded") setExportStatus(`Saved to “${folder}”. Delete the file once you're done with it.`);
    else if (status === "writeFailed") setExportStatus(t(`Couldn't write the file. Try another folder.`));
    else if (status === "inProgress") setExportStatus(t(`An export is already running.`));
    else setExportStatus("");
  };

  const shown = (list ?? []).filter((p) => matchesQuery(query, p.origin, p.username));
  const rows = useGrowingRows(shown.length, `${profile}|${query}`);

  return (
    <ProfileSubPage>
      <SectionHeader
        title={t(`Passwords`)}
        description={`Saved on this ${PLATFORM_TERMS.computer}, separately for each profile, and encrypted with ${PLATFORM_TERMS.passwordKey}.`}
      />
      <Group>
        <Row title={t(`Import passwords`)} description={importStatus || t(`From a CSV exported by Chrome, Safari, Firefox, 1Password, Bitwarden…`)}>
          <Button title={t(`Import CSV…`)} onPress={() => void importCsv()} />
        </Row>
        {PLATFORM_FEATURES.exportsBookmarksAndPasswords ? (
          <Row title={t(`Export passwords`)} description={exportStatus || t(`To a CSV file. Anyone who can open the file can read your passwords.`)}>
            <Button title={t(`Export CSV…`)} onPress={() => void exportCsv()} />
          </Row>
        ) : null}
        <Row
          icon={<Symbol name="questionmark.circle" size={15} color={theme.icon} style={HELP_ICON} />}
          title={t(`Password manager apps`)}
          description={passwordManagerAppsNote()}
        />
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
          <Button title={t(`Unlock`)} kind="primary" onPress={() => void unlockPasswordsFor(profile)} />
        </Box>
      ) : (
        <>
          <SectionHeader
            title={list ? plural(list.length, t(`Saved Password`)) : t(`Saved Passwords`)}
            action={<SearchField value={query} onChangeText={setQuery} placeholder={t(`Search`)} width={200} />}
          />
          <Group>
            {list && shown.length === 0 ? (
              <Row title={query ? t(`No passwords match`) : t(`No saved passwords`)} />
            ) : (
              shown.slice(0, rows).map((p) => (
                <Row
                  key={`${p.origin}|${p.username}`}
                  icon={<Favicon url={p.origin} />}
                  title={hostLabel(p.origin)}
                  description={p.username || t(`(no username)`)}
                  onPress={() => showSettingsSheet(<PasswordSheet profile={profile} saved={p} onChanged={load} />)}
                />
              ))
            )}
          </Group>
          {never.length > 0 && (
            <>
              <SectionHeader title={t(`Never saved`)} description={t(`Sites where you chose “Never on This Site”.`)} />
              <Group>
                {never.map((origin) => (
                  <Row key={origin} icon={<Favicon url={origin} />} title={hostLabel(origin)}>
                    <Button title={t(`Remove`)} onPress={() => void setNeverSavePasswords(profile, origin, false).catch(orWarn(undefined)).then(load)} />
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

function PasswordSheet({ profile, saved, onChanged }: { profile: string; saved: SavedPassword; onChanged: () => void }) {
  const [username, setUsername] = useState(saved.username);
  const [password, setPassword] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const open = useRef(true);
  const unlocked = usePasswordsUnlocked(profile);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  useEffect(() => void revealPassword(profile, saved.origin, saved.username).then(setPassword), []);
  useEffect(() => {
    if (unlocked) return;
    setPassword(null);
    closeSettingsSheet();
  }, [unlocked]);

  const save = async () => {
    setError("");
    setBusy(true);
    const changed = await updatePassword(profile, saved.origin, saved.username, {
      username: username !== saved.username ? username : undefined,
      password: password ?? undefined,
    }).catch(orWarn(false, t(`settings edit`)));
    if (changed) onChanged();
    if (!open.current) return;
    setBusy(false);
    if (!changed) return setError(t(`Couldn't confirm that the change was saved. It may still appear in the list in a moment.`));
    closeSettingsSheet();
  };
  const remove = async () => {
    setBusy(true);
    const { confirmed } = await confirm({
      title: `Delete the password for ${hostLabel(saved.origin)}?`,
      message: t(`You won't be able to sign in with it automatically any more.`),
      confirmTitle: t(`Delete`),
      destructive: true,
    });
    if (!confirmed) return setBusy(false);
    await deletePassword(profile, saved.origin, saved.username).catch(orWarn(false, t(`settings delete`)));
    onChanged();
    closeSettingsSheet();
  };

  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle icon={<Favicon url={saved.origin} size={20} />}>{hostLabel(saved.origin)}</DialogTitle>
      <View style={SHEET_BODY}>
        <Group>
          <Row title={t(`Website`)} description={saved.origin} />
          <Row title={t(`Username`)}>
            {editing ? (
              <TextField value={username} onChangeText={setUsername} width={220} />
            ) : (
              <Box row gap="xs" style={CENTER}>
                <Text selectable>{saved.username}</Text>
                <Button variant="icon" icon="doc.on.doc" size="m" onPress={() => copyText(saved.username)} tooltip={t(`Copy Username`)} />
              </Box>
            )}
          </Row>
          <Row title={t(`Password`)}>
            {editing ? (
              <TextField value={password ?? ""} onChangeText={setPassword} secure={!revealed} width={220} />
            ) : (
              <Box row gap="xs" style={CENTER}>
                <Text selectable style={revealed ? monoFace() : undefined}>
                  {password === null ? "…" : revealed ? password : "•".repeat(Math.min(password.length, 12))}
                </Text>
                <Button variant="icon" icon={revealed ? "eye.slash" : "eye"} size="m" onPress={() => setRevealed(!revealed)} tooltip={revealed ? t(`Hide`) : t(`Show`)} />
                <Button variant="icon" icon="doc.on.doc" size="m" onPress={() => password && copyText(password)} tooltip={t(`Copy Password`)} />
              </Box>
            )}
          </Row>
        </Group>
        {error ? (
          <Text size="caption" tone="destructive" style={ERROR}>
            {error}
          </Text>
        ) : null}
      </View>
      <DialogActions leading={<Button title={t(`Delete`)} kind="destructive" disabled={busy} onPress={() => void remove()} />}>
        {editing ? (
          <>
            <Button
              title={t(`Cancel`)}
              disabled={busy}
              onPress={() => {
                setError("");
                setEditing(false);
              }}
            />
            <Button title={t(`Save`)} kind="primary" disabled={!password || busy} onPress={() => void save()} />
          </>
        ) : (
          <>
            <Button title={t(`Edit`)} onPress={() => setEditing(true)} />
            <Button title={t(`Done`)} kind="primary" onPress={closeSettingsSheet} />
          </>
        )}
      </DialogActions>
    </Sheet>
  );
}

const HELP_ICON = { width: 20, height: 20 } as const;
const LOCKED = { alignItems: "center", marginTop: settingsLayout.emptyTop } as const;
const LOCK_ICON = { width: 36, height: 36 } as const;
const SHEET_BODY = { marginTop: space.xl } as const;
const ERROR = { marginTop: space.ml } as const;
const CENTER = { alignItems: "center" } as const;
