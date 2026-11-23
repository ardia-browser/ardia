import { memo, useEffect, useMemo, useRef, useState } from "react";
import { View, type TextInput } from "react-native";
import type { VaultStandaloneCode } from "../../state/vaults/types";
import { copyStandaloneCode } from "../../state/vaults/loginFormActions";
import { confirm } from "../../state/app/system";
import { closeSettingsSheet, showSettingsSheet } from "../../state/settings/sheet";
import { normalizeWebsite } from "../../state/vaults/loginForm";
import { siteLabel } from "../../state/vaults/originMatch";
import { removeStandaloneCode, renameStandaloneCode, useStandaloneCodes } from "../../state/vaults/standaloneCodes";
import { matchingCodes } from "../../state/vaults/standaloneCodesModel";
import { Button, Dialog, DialogActions, DialogTitle, Divider, Expand, space, Symbol, Text, TextField, useListPresence, useTheme } from "../ui";
import { Favicon } from "../favicon/Favicon";
import { Group, Row, SectionHeader } from "../settings/Form";
import { useGrowingRows } from "../../state/settings/growingRows";
import { LiveCode } from "./VaultCodeRows";
import { VAULT_FORM, VAULT_SETTINGS } from "./tokens";

const COUNT = new Intl.NumberFormat();
const ANIMATED_ROWS = 60;
const ARDIA = "ardia";

const itemOf = (code: VaultStandaloneCode) => ({ provider: ARDIA, id: code.id, hasTotp: true });

const copyCode = (code: VaultStandaloneCode) => copyStandaloneCode(code.id);

function CodeIcon({ code, size = VAULT_SETTINGS.siteIcon }: { code: VaultStandaloneCode; size?: number }) {
  const theme = useTheme();
  if (code.website) return <Favicon url={code.website} size={size} />;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Symbol name="clock.badge.checkmark" size={VAULT_FORM.titleGlyph} color={theme.textSecondary} style={{ width: size, height: size }} />
    </View>
  );
}

const issuerOf = (code: VaultStandaloneCode) => (!code.issuer || code.issuer.trim().toLocaleLowerCase() === code.label.trim().toLocaleLowerCase() ? "" : code.issuer);

const detailOf = (code: VaultStandaloneCode) => issuerOf(code) || (code.website ? siteLabel(code.website) : "");

const shownWebsite = (website: string | null | undefined) => (website && normalizeWebsite(siteLabel(website)) === website ? siteLabel(website) : (website ?? ""));

const CodeRow = memo(function CodeRow({ code }: { code: VaultStandaloneCode }) {
  const item = useMemo(() => itemOf(code), [code.id]);
  return (
    <Row
      icon={<CodeIcon code={code} />}
      title={<Text numberOfLines={1}>{code.label}</Text>}
      description={detailOf(code) ? <Text size="caption" tone="textSecondary" numberOfLines={1} style={DETAIL}>{detailOf(code)}</Text> : undefined}
      onPress={() => showSettingsSheet(<CodeSheet code={code} />)}
    >
      <LiveCode item={item} onCopy={() => copyCode(code)} />
    </Row>
  );
});

const keyOf = (code: VaultStandaloneCode) => code.id;

function GrowingCodeRows({ codes, query }: { codes: readonly VaultStandaloneCode[]; query: string }) {
  const rows = useGrowingRows(codes.length, `codes|${query}`);
  return (
    <View>
      {codes.slice(0, rows).map((code, i) => (
        <View key={code.id}>
          {i > 0 ? <Divider thick inset="l" /> : null}
          <CodeRow code={code} />
        </View>
      ))}
    </View>
  );
}

function AnimatedCodeRows({ codes }: { codes: readonly VaultStandaloneCode[] }) {
  const { list, drop } = useListPresence(codes, keyOf);
  return (
    <View>
      {list.map((p, i) => (
        <Expand key={p.key} open={p.present} appear={p.appear} onClosed={() => drop(p.key)}>
          {i > 0 ? <Divider thick inset="l" /> : null}
          <CodeRow code={p.item} />
        </Expand>
      ))}
    </View>
  );
}

export function VerificationCodesSection({ query, onAdd }: { query: string; onAdd: () => void }) {
  const codes = useStandaloneCodes((s) => s.codes);
  const shown = useMemo(() => matchingCodes(codes ?? [], query), [codes, query]);
  const open = shown.length > 0;
  return (
    <Expand open={open}>
      <SectionHeader title={`${COUNT.format(shown.length)} Verification Code${shown.length === 1 ? "" : "s"}`} action={<Button variant="icon" icon="plus" size="m" tooltip="New Verification Code" onPress={onAdd} />} />
      <Group>{shown.length > ANIMATED_ROWS ? <GrowingCodeRows codes={shown} query={query} /> : <AnimatedCodeRows codes={shown} />}</Group>
    </Expand>
  );
}

function CodeSheet({ code }: { code: VaultStandaloneCode }) {
  const [label, setLabel] = useState(code.label);
  const [website, setWebsite] = useState(() => shownWebsite(code.website));
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const labelInput = useRef<TextInput>(null);
  const websiteInput = useRef<TextInput>(null);
  const live = useStandaloneCodes((s) => s.codes?.find((c) => c.id === code.id) ?? null);
  const item = useMemo(() => itemOf(code), [code.id]);
  const websiteOk = !website.trim() || !!normalizeWebsite(website);
  const changed = label.trim() !== code.label || (normalizeWebsite(website) ?? "") !== (code.website ?? "");

  const run = async (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    await work().finally(() => {
      running.current = false;
      setBusy(false);
    });
  };
  const save = () =>
    run(async () => {
      if (!label.trim()) return setProblem("Enter a label.");
      if (!websiteOk) return setProblem("Enter a website, like example.com.");
      if (!changed) return closeSettingsSheet();
      const outcome = await renameStandaloneCode(code.id, label, normalizeWebsite(website));
      if (outcome.ok) return closeSettingsSheet();
      setProblem(outcome.error ?? "");
    });
  const remove = () =>
    run(async () => {
      const { confirmed } = await confirm({
        title: `Delete the Code for ${code.label}?`,
        message: "Keep another way to sign in before you delete it.",
        confirmTitle: "Delete",
        destructive: true,
      });
      if (!confirmed) return;
      const outcome = await removeStandaloneCode(code.id);
      if (outcome.ok) return closeSettingsSheet();
      setProblem(outcome.error ?? "");
    });

  useEffect(() => {
    if (!live && !running.current) closeSettingsSheet();
  }, [live]);
  return (
    <Dialog width="m" maxHeight="90%" onDismiss={closeSettingsSheet} onSubmit={() => void save()}>
      <DialogTitle icon={<CodeIcon code={code} />} subtitle={issuerOf(code) || undefined}>
        {code.label}
      </DialogTitle>
      <View style={BODY}>
        <Group>
          <Row title="Code">
            <LiveCode item={item} onCopy={() => copyCode(code)} />
          </Row>
          <Row title="Label">
            <TextField inputRef={labelInput} onFieldTab={() => websiteInput.current?.focus()} value={label} onChangeText={(t) => (setLabel(t), setProblem(""))} placeholder="Required" invalid={!label.trim()} onSubmit={() => void save()} onEscape={closeSettingsSheet} width={VAULT_FORM.field} />
          </Row>
          <Row title="Website">
            <TextField inputRef={websiteInput} onFieldTab={() => labelInput.current?.focus()} value={website} onChangeText={(t) => (setWebsite(t), setProblem(""))} placeholder="Optional" invalid={!websiteOk} onSubmit={() => void save()} onEscape={closeSettingsSheet} width={VAULT_FORM.field} />
          </Row>
        </Group>
        <Expand open={!!problem} gap={space.ml}>
          <Text size="caption" tone="destructive">
            {problem}
          </Text>
        </Expand>
      </View>
      <DialogActions leading={<Button title="Delete" kind="destructive" disabled={busy} onPress={() => void remove()} />}>
        <Button title="Cancel" disabled={busy} onPress={closeSettingsSheet} />
        <Button title={changed ? "Save" : "Done"} kind="primary" disabled={busy} onPress={() => void save()} />
      </DialogActions>
    </Dialog>
  );
}

export { CodeSheet };

const BODY = { marginTop: space.xl } as const;
const DETAIL = { marginTop: space.xxs } as const;
