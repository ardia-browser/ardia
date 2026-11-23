import { useState } from "react";
import { View } from "react-native";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { confirm, showMenu } from "../../state/app/system";
import { openSettings } from "../../state/settings/settingsWindows";
import { copyInstallCommand, lockProvider, refreshProvider, restartProvider, signInError, signOutProvider, unlockProvider, type VaultProviderState } from "../../state/vaults/actions";
import { exportManagerPasswords } from "../../state/vaults/export";
import { joinSignIn } from "../../state/vaults/signInRequest";
import { addPasswordManager, dismissAddingManager, turnOnPasswordManager, type AddingManager, type CatalogueEntry } from "../../state/vaults/managerCatalogue";
import { managerStatus, type ManagerStatus } from "../../state/vaults/managerStatus";
import { groupGround, readableInk } from "../../state/vaults/readableInk";
import { credential, titleOf, type CredentialProviderState } from "../../state/vaults/providerModel";
import { ActivitySpinner, Box, Button, space, Text, Toggle, useTheme } from "../ui";
import { useSettings } from "../../state/browser/hooks";
import { updateSettings } from "../../state/settings/actions";
import { font as typeScale, lineHeight } from "../ui/tokens";
import { Row } from "../settings/Form";
import { BrandBadge, useCopiedFlash } from "./VaultParts";
import { VAULT_BADGE, VAULT_SETTINGS } from "./tokens";

export const UNLOCK_TITLES = ["Unlock", "Unlocking…"] as const;
const COPY_TITLES = ["Copy", "Copied"] as const;
const CHECK_TITLES = ["Check Again", "Checking…"] as const;

export type ManagerSheets = { connect: (provider: string) => void; unlock: (provider: string) => void };

function StatusLine({ text, tone }: { text: string; tone: ManagerStatus["tone"] }) {
  const theme = useTheme();
  const warning = tone === "warning" ? readableInk(theme.warning, groupGround(theme.groupFill, theme.dark ? VAULT_SETTINGS.paneGround.dark : VAULT_SETTINGS.paneGround.light), theme.textPrimary) : null;
  return (
    <Text size="caption" tone={tone} style={warning ? [STATUS, { color: warning }] : STATUS}>
      {text}
    </Text>
  );
}

function CommandLine({ command }: { command: string }) {
  const [copied, flash] = useCopiedFlash();
  return (
    <View style={COMMAND_LINE}>
      <Text selectable lines={1} tone="textSecondary" style={COMMAND}>
        {command}
      </Text>
      <Button
        title={copied ? "Copied" : "Copy"}
        icon={copied ? "checkmark" : "doc.on.doc"}
        label={copied ? "Copied" : "Copy Command"}
        reserve={COPY_TITLES}
        onPress={() => {
          void copyInstallCommand(command);
          flash();
        }}
      />
    </View>
  );
}

async function moreFor(p: CredentialProviderState, setError: (text: string) => void) {
  const connected = p.state === "unlocked" || p.state === "locked";
  const choice = await showMenu([
    ...(p.state === "unlocked" ? [{ id: "lock", title: "Lock", symbol: "lock" }] : []),
    ...(p.state === "unlocked" && PLATFORM_FEATURES.exportsBookmarksAndPasswords ? [{ id: "export", title: "Export Passwords…", symbol: "square.and.arrow.up" }] : []),
    ...(connected ? [{ separator: true as const }, { id: "signOut", title: "Sign Out…", symbol: "rectangle.portrait.and.arrow.right" }] : []),
    ...(p.plugin ? [{ separator: true as const }, { id: "plugin", title: "Show in Plugins", symbol: "puzzlepiece.extension" }] : []),
  ]);
  if (choice === "lock") await lockProvider(p.id);
  if (choice === "export") setError(await exportManagerPasswords(p.id));
  if (choice === "plugin") openSettings("plugins", null, p.plugin);
  if (choice !== "signOut") return;
  const name = titleOf(p);
  const { confirmed } = await confirm({ title: `Sign Out of ${name}?`, message: "Ardia stops filling from it until you sign in again.", confirmTitle: "Sign Out" });
  if (confirmed) await signOutProvider(p.id);
}

export function ProviderRow({ provider, sheets }: { provider: VaultProviderState; sheets: ManagerSheets }) {
  const p = credential(provider);
  const status = managerStatus(p);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = titleOf(p);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    await work().finally(() => setBusy(false));
  };
  const unlock = () =>
    run(async () => {
      const result = await joinSignIn(p.id, () => unlockProvider(p.id, null));
      if (result.needs === "password") sheets.unlock(p.id);
      else if (!result.ok) setError(signInError(result, name));
    });
  const check = () => run(async () => void (await refreshProvider(p.id)));
  const trailing = {
    unlock: <Button title={busy ? "Unlocking…" : "Unlock"} reserve={UNLOCK_TITLES} disabled={busy} onPress={() => void unlock()} />,
    signIn: <Button title="Sign In…" onPress={() => sheets.connect(p.id)} />,
    continue: <Button title="Continue…" onPress={() => sheets.connect(p.id)} />,
    restart: <Button title="Restart" onPress={() => restartProvider(p.plugin ?? p.id)} />,
    turnOn: <Button title="Turn On…" onPress={() => void turnOnPasswordManager({ name: p.plugin ?? p.id, title: name, icon: p.symbol ?? "", accent: p.accent }, sheets.connect)} />,
    check: <Button title={busy ? "Checking…" : "Check Again"} reserve={CHECK_TITLES} disabled={busy} onPress={() => void check()} />,
    none: null,
  }[status.action];
  const updating = p.unavailable?.reason === "updating";
  return (
    <View>
      <Row icon={<BrandBadge provider={p.id} size="m" />} title={name} description={<StatusLine text={error || status.line} tone={error ? "destructive" : status.tone} />}>
        <Box row gap="s" center>
          {updating ? <ActivitySpinner style={SPINNER} /> : null}
          {trailing}
          {status.menu ? <Button variant="icon" icon="ellipsis.circle" size="l" tooltip="More" onPress={() => void moreFor(p, setError)} /> : null}
        </Box>
      </Row>
      {status.command ? <CommandLine command={status.command} /> : null}
    </View>
  );
}

export function AddingRow({ adding, onReady }: { adding: AddingManager; onReady: (provider: string) => void }) {
  const failed = adding.phase === "failed";
  return (
    <Row
      icon={<BrandBadge provider={adding.name} size="m" symbol={adding.icon || undefined} accent={adding.accent} />}
      title={adding.title}
      description={<StatusLine text={failed ? adding.reason : adding.turningOn ? "Turning On…" : "Installing…"} tone={failed ? "destructive" : "textSecondary"} />}
    >
      <Box row gap="s" center>
        {failed ? (
          <>
            <Button title="Try Again" onPress={() => void addPasswordManager(adding, onReady)} />
            <Button variant="icon" icon="xmark.circle.fill" size="l" tooltip="Dismiss" onPress={dismissAddingManager} />
          </>
        ) : (
          <ActivitySpinner style={SPINNER} />
        )}
      </Box>
    </Row>
  );
}

export function OffRow({ entry, sheets }: { entry: CatalogueEntry; sheets: ManagerSheets }) {
  const more = async () => {
    const choice = await showMenu([{ id: "plugin", title: "Show in Plugins", symbol: "puzzlepiece.extension" }]);
    if (choice === "plugin") openSettings("plugins", null, entry.name);
  };
  return (
    <Row icon={<BrandBadge provider={entry.name} size="m" symbol={entry.icon || undefined} accent={entry.accent} />} title={entry.title} description={<StatusLine text="Off" tone="textSecondary" />}>
      <Box row gap="s" center>
        <Button title="Turn On…" label={`Turn On ${entry.title}`} onPress={() => void turnOnPasswordManager(entry, sheets.connect)} />
        <Button variant="icon" icon="ellipsis.circle" size="l" tooltip="More" onPress={() => void more()} />
      </Box>
    </Row>
  );
}

const TOUCH_UNLOCK = "Unlock with Touch ID";

export function TouchUnlockRow() {
  const on = useSettings((s) => s.vaultTouchID);
  return (
    <Row title={TOUCH_UNLOCK}>
      <Toggle value={on} accessibilityLabel={TOUCH_UNLOCK} onChange={(v) => updateSettings({ vaultTouchID: v })} />
    </Row>
  );
}

const STATUS = { marginTop: space.xxs, lineHeight: lineHeight.caption } as const;
const COMMAND_LINE = { flexDirection: "row", alignItems: "center", gap: space.m, marginTop: -space.xs, paddingLeft: space.l + VAULT_BADGE.m.box + space.l, paddingRight: space.l, paddingBottom: space.m } as const;
const COMMAND = { flex: 1, fontFamily: "Menlo", ...typeScale.small } as const;
const SPINNER = { width: VAULT_SETTINGS.spinner, height: VAULT_SETTINGS.spinner } as const;
