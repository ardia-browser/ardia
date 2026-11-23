import { useRef, useState } from "react";
import { View } from "react-native";
import { ago } from "../../../lib/time";
import { confirm, showMenu } from "../../../state/app/system";
import { useSettings } from "../../../state/browser/hooks";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import {
  copyGenerated,
  deleteGenerated,
  generatedSaveMenu,
  generatedSaveTargets,
  NEEDS_USERNAME,
  saveGenerated,
  type VaultGeneratedPassword,
} from "../../../state/vaults/generated";
import { fillGeneratedNow } from "../../../state/vaults/generatedFill";
import { useGeneratedFillable, useKeptGeneratedPasswords, useVaultLogins, useVaultProviders } from "../../../state/vaults/hooks";
import { siteLabel } from "../../../state/vaults/originMatch";
import { useRankedUsernames } from "../../../state/vaults/usernameSuggestions";
import { Favicon } from "../../favicon/Favicon";
import { matchesQuery } from "../../pages/PageLayout";
import { Box, Button, DialogActions, DialogTitle, Divider, Expand, Sheet, space, Text, useListPresence } from "../../ui";
import { CopyButton, useManagerName } from "../../vaults/VaultParts";
import { VAULT_SAVE, VAULT_SETTINGS } from "../../vaults/tokens";
import { VaultUsernameField } from "../../vaults/VaultUsernameField";
import { Group, Row, SectionHeader } from "../Form";

const DELETE = "delete";

const SAVE_FAILED = "Couldn't save it. Unlock the password manager and try again.";

type SaveProps = { entry: VaultGeneratedPassword; provider: string; profile: string };

function SaveSheet({ entry, provider, profile }: SaveProps) {
  const nameOf = useManagerName();
  const ranked = useRankedUsernames(useVaultLogins(), true);
  const [username, setUsername] = useState(ranked[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const saving = useRef(false);
  const site = siteLabel(entry.origin);
  const save = async () => {
    if (!username.trim() || saving.current) return;
    saving.current = true;
    setBusy(true);
    const result = await saveGenerated(entry.id, provider, username, profile).finally(() => (saving.current = false));
    setBusy(false);
    if (!result.saved) return setProblem(SAVE_FAILED);
    closeSettingsSheet();
  };
  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle icon={<Favicon url={entry.origin} size={VAULT_SETTINGS.siteIcon} />}>{`Save Password for ${site}?`}</DialogTitle>
      <View style={SHEET_BODY}>
        <VaultUsernameField value={username} ranked={ranked} onChange={setUsername} autoFocus onSubmit={() => void save()} onEscape={closeSettingsSheet} width={VAULT_SAVE.usernameWidth} />
        <Expand open={!!problem} gap={space.ml}>
          <Text size="caption" tone="destructive">
            {problem}
          </Text>
        </Expand>
      </View>
      <DialogActions>
        <Button title="Cancel" disabled={busy} onPress={closeSettingsSheet} />
        <Button title={busy ? "Saving…" : `Save to ${nameOf(provider)}`} kind="primary" disabled={busy || !username.trim()} onPress={() => void save()} />
      </DialogActions>
    </Sheet>
  );
}

function GeneratedRow({ entry, profile }: { entry: VaultGeneratedPassword; profile: string }) {
  const providers = useVaultProviders();
  const nameOf = useManagerName();
  const fillable = useGeneratedFillable(entry.origin);
  const chosen = useSettings((s) => s.vaultSaveTarget);
  const targets = generatedSaveTargets(providers, chosen);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const site = siteLabel(entry.origin);
  const copy = async () => {
    const outcome = await copyGenerated(entry.id);
    setProblem(outcome === "copied" || outcome === "declined" ? "" : "Couldn't copy the password. Try again.");
    return outcome;
  };
  const fill = async () => {
    const outcome = await fillGeneratedNow(entry);
    setProblem(outcome === "filled" || outcome === "declined" ? "" : "Couldn't fill it. Click the password field, then try again.");
  };
  const saving = useRef(false);
  const saveTo = async (provider: string) => {
    if (!entry.username.trim()) return showSettingsSheet(<SaveSheet entry={entry} provider={provider} profile={profile} />);
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    const result = await saveGenerated(entry.id, provider, null, profile).finally(() => (saving.current = false));
    setBusy(false);
    if (result.error === NEEDS_USERNAME) return showSettingsSheet(<SaveSheet entry={entry} provider={provider} profile={profile} />);
    setProblem(result.saved ? "" : SAVE_FAILED);
  };
  const more = async () => {
    const choice = await showMenu([...generatedSaveMenu(targets, nameOf).map((t) => ({ ...t, checked: false })), ...(targets.length ? [{ separator: true as const }] : []), { id: DELETE, title: "Delete…", symbol: "trash" }]);
    if (choice === DELETE) await remove();
    else if (choice) await saveTo(choice);
  };
  const remove = async () => {
    const { confirmed } = await confirm({
      title: `Delete Generated Password for ${site}?`,
      message: "It isn't saved anywhere else, so you can't get it back.",
      confirmTitle: "Delete",
      destructive: true,
    });
    if (confirmed) await deleteGenerated(entry.id);
  };
  return (
    <Row icon={<Favicon url={entry.origin} size={VAULT_SETTINGS.siteIcon} />} title={site} description={problem || `${entry.username || "No Username"} · Generated ${ago(entry.createdAt)}`}>
      <Box row gap="xs" center>
        {fillable ? <Button title="Fill" onPress={() => void fill()} /> : null}
        <CopyButton label="Password" onCopy={copy} />
        <Button variant="icon" icon="ellipsis.circle" size="m" tooltip="More" disabled={busy} onPress={() => void more()} />
      </Box>
    </Row>
  );
}

export function GeneratedPasswordsSection({ query, profile }: { query: string; profile: string }) {
  const entries = useKeptGeneratedPasswords();
  const { list, drop } = useListPresence(entries, (e) => e.id);
  const shown = list.filter((p) => matchesQuery(query, p.item.origin, p.item.username));
  if (!shown.length) return null;
  return (
    <Expand open={shown.some((p) => p.present)}>
      <SectionHeader title="Generated Passwords" />
      <Group>
        <View>
          {shown.map((p, i) => (
            <Expand key={p.key} open={p.present} appear={p.appear} onClosed={() => drop(p.key)}>
              {i > 0 ? <Divider thick inset="l" /> : null}
              <GeneratedRow entry={p.item} profile={profile} />
            </Expand>
          ))}
        </View>
      </Group>
    </Expand>
  );
}

const SHEET_BODY = { marginTop: space.xl, gap: space.ml } as const;
