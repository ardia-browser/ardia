import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { deletePassword, updatePassword, type SavedPassword } from "../../../state/site/passwords";
import { orWarn } from "../../../lib/fallback";
import { confirm, copyText } from "../../../state/app/system";
import { Box, Button, DialogActions, DialogTitle, Sheet, space, Text, TextField } from "../../ui";
import { monoFace } from "../../ui/tokens";
import { revealPassword, usePasswordsUnlocked } from "../../../state/site/savedPasswords";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { hostLabel } from "../../pages/PageLayout";
import { Favicon } from "../../favicon/Favicon";
import { Group, Row } from "../Form";
import { useVaultSiteItems } from "../../../state/vaults/hooks";
import { ArdiaCodeRow } from "../../vaults/VaultCodeRows";
import { LoginFormSheet } from "../../vaults/LoginFormSheet";
import { SavedInRow, WebsiteRow } from "../../vaults/VaultSheetRows";
import { ARDIA_PROVIDER } from "../../../state/vaults/ardia";
import { brandOf } from "../../../state/vaults/brands";
import { deleteLoginMessage } from "../../../state/vaults/deleteLogin";
import { ardiaLoginDeleted, ardiaLoginOf, copySavedPassword } from "../../../state/vaults/ardiaCodes";

export type SheetContext = { profile: string; list: readonly SavedPassword[]; ardia: boolean; onChanged: () => void };

export const showSaved = (saved: SavedPassword, context: SheetContext) =>
  showSettingsSheet(context.ardia ? <ArdiaPasswordSheet saved={saved} {...context} /> : <PasswordSheet profile={context.profile} saved={saved} onChanged={context.onChanged} />);

function ArdiaPasswordSheet({ profile, saved, list, onChanged, ardia }: { saved: SavedPassword } & SheetContext) {
  const [password, setPassword] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const unlocked = usePasswordsUnlocked(profile);
  const ardiaItem = ardiaLoginOf(useVaultSiteItems(saved.origin), profile, saved.origin, saved.username);
  useEffect(() => void revealPassword(profile, saved.origin, saved.username).then(setPassword), []);
  useEffect(() => {
    if (unlocked) return;
    setPassword(null);
    closeSettingsSheet();
  }, [unlocked]);

  const context: SheetContext = { profile, list, ardia, onChanged };
  const edit = () =>
    showSettingsSheet(
      <LoginFormSheet target={{ kind: "ardia", profile, saved, list, hasCode: ardiaItem?.hasTotp === true, onSaved: onChanged, onShowExisting: (other) => showSaved(other, context) }} />,
    );
  const remove = async () => {
    setBusy(true);
    const { confirmed } = await confirm({
      title: `Delete Password for ${hostLabel(saved.origin)}?`,
      message: deleteLoginMessage(saved, list),
      confirmTitle: "Delete",
      destructive: true,
    });
    if (!confirmed) return setBusy(false);
    if (await deletePassword(profile, saved.origin, saved.username).catch(orWarn(false, "settings delete"))) void ardiaLoginDeleted(profile, saved.origin, saved.username);
    onChanged();
    closeSettingsSheet();
  };

  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle icon={<Favicon url={saved.origin} size={20} />}>{hostLabel(saved.origin)}</DialogTitle>
      <View style={SHEET_BODY}>
        <Group>
          <WebsiteRow url={saved.origin} />
          <Row title="Username">
            <Box row gap="xs" style={CENTER}>
              <Text selectable>{saved.username || "No username"}</Text>
              {saved.username ? <Button variant="icon" icon="doc.on.doc" size="m" onPress={() => copyText(saved.username)} tooltip="Copy Username" /> : null}
            </Box>
          </Row>
          <Row title="Password">
            <Box row gap="xs" style={CENTER}>
              <Text selectable style={revealed ? monoFace() : undefined}>
                {password === null ? "…" : revealed ? password : "•".repeat(Math.min(password.length, 12))}
              </Text>
              <Button variant="icon" icon={revealed ? "eye.slash" : "eye"} size="m" onPress={() => setRevealed(!revealed)} tooltip={revealed ? "Hide" : "Show"} />
              <Button variant="icon" icon="doc.on.doc" size="m" onPress={() => void copySavedPassword(ardiaItem, password)} tooltip="Copy Password" />
            </Box>
          </Row>
          {ardiaItem ? <ArdiaCodeRow item={ardiaItem} editing={false} onProblem={setError} /> : null}
          <SavedInRow provider={ARDIA_PROVIDER} name={brandOf(ARDIA_PROVIDER).name} />
        </Group>
        {error ? (
          <Text size="caption" tone="destructive" style={ERROR}>
            {error}
          </Text>
        ) : null}
      </View>
      <DialogActions leading={<Button title="Delete" kind="destructive" disabled={busy} onPress={() => void remove()} />}>
        <Button title="Edit" disabled={busy} onPress={edit} />
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </DialogActions>
    </Sheet>
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
    }).catch(orWarn(false, "settings edit"));
    if (changed) onChanged();
    if (!open.current) return;
    setBusy(false);
    if (!changed) return setError("Couldn't confirm that the change was saved. It may still appear in the list in a moment.");
    closeSettingsSheet();
  };
  const remove = async () => {
    setBusy(true);
    const { confirmed } = await confirm({
      title: `Delete the password for ${hostLabel(saved.origin)}?`,
      message: "You won't be able to sign in with it automatically any more.",
      confirmTitle: "Delete",
      destructive: true,
    });
    if (!confirmed) return setBusy(false);
    await deletePassword(profile, saved.origin, saved.username).catch(orWarn(false, "settings delete"));
    onChanged();
    closeSettingsSheet();
  };

  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle icon={<Favicon url={saved.origin} size={20} />}>{hostLabel(saved.origin)}</DialogTitle>
      <View style={SHEET_BODY}>
        <Group>
          <WebsiteRow url={saved.origin} />
          <Row title="Username">
            {editing ? (
              <TextField value={username} onChangeText={setUsername} width={220} />
            ) : (
              <Box row gap="xs" style={CENTER}>
                <Text selectable>{saved.username}</Text>
                <Button variant="icon" icon="doc.on.doc" size="m" onPress={() => copyText(saved.username)} tooltip="Copy Username" />
              </Box>
            )}
          </Row>
          <Row title="Password">
            {editing ? (
              <TextField value={password ?? ""} onChangeText={setPassword} secure={!revealed} width={220} />
            ) : (
              <Box row gap="xs" style={CENTER}>
                <Text selectable style={revealed ? monoFace() : undefined}>
                  {password === null ? "…" : revealed ? password : "•".repeat(Math.min(password.length, 12))}
                </Text>
                <Button variant="icon" icon={revealed ? "eye.slash" : "eye"} size="m" onPress={() => setRevealed(!revealed)} tooltip={revealed ? "Hide" : "Show"} />
                <Button variant="icon" icon="doc.on.doc" size="m" onPress={() => password && copyText(password)} tooltip="Copy Password" />
              </Box>
            )}
          </Row>
          <SavedInRow provider={ARDIA_PROVIDER} name={brandOf(ARDIA_PROVIDER).name} />
        </Group>
        {error ? (
          <Text size="caption" tone="destructive" style={ERROR}>
            {error}
          </Text>
        ) : null}
      </View>
      <DialogActions leading={<Button title="Delete" kind="destructive" disabled={busy} onPress={() => void remove()} />}>
        {editing ? (
          <>
            <Button
              title="Cancel"
              disabled={busy}
              onPress={() => {
                setError("");
                setEditing(false);
              }}
            />
            <Button title="Save" kind="primary" disabled={!password || busy} onPress={() => void save()} />
          </>
        ) : (
          <>
            <Button title="Edit" onPress={() => setEditing(true)} />
            <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
          </>
        )}
      </DialogActions>
    </Sheet>
  );
}

const SHEET_BODY = { marginTop: space.xl } as const;
const ERROR = { marginTop: space.ml } as const;
const CENTER = { alignItems: "center" } as const;
