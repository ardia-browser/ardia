import { memo, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import type { VaultPasskey } from "../../state/vaults/types";
import { confirm } from "../../state/app/system";
import { closeSettingsSheet, showSettingsSheet } from "../../state/settings/sheet";
import { siteLabel } from "../../state/vaults/originMatch";
import { deletePasskey, loadPasskeys, usePasskeys } from "../../state/vaults/passkeys";
import { queryWords, searchText } from "../pages/PageLayout";
import { Button, Dialog, DialogActions, DialogTitle, Divider, Expand, space, Text, useListPresence } from "../ui";
import { Favicon } from "../favicon/Favicon";
import { Group, Row, SectionHeader } from "../settings/Form";
import { useGrowingRows } from "../../state/settings/growingRows";
import { BrandBadge, useManagerName } from "./VaultParts";
import { VAULT_SETTINGS } from "./tokens";

const COUNT = new Intl.NumberFormat();
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const ANIMATED_ROWS = 60;

const siteOf = (passkey: VaultPasskey) => `https://${passkey.rpId}`;
const accountOf = (passkey: VaultPasskey) => passkey.userName || passkey.displayName || "No Username";
const keyOf = (passkey: VaultPasskey) => `${passkey.provider}:${passkey.id}`;

export function matchingPasskeys(list: readonly VaultPasskey[], query: string): VaultPasskey[] {
  const words = queryWords(query);
  if (!words.length) return [...list];
  return list.filter((p) => {
    const text = searchText(p.rpId, p.userName, p.displayName);
    return words.every((w) => text.includes(w));
  });
}

const PasskeyRow = memo(function PasskeyRow({ passkey }: { passkey: VaultPasskey }) {
  const nameOf = useManagerName();
  return (
    <Row
      icon={<Favicon url={siteOf(passkey)} size={VAULT_SETTINGS.siteIcon} />}
      title={<Text numberOfLines={1}>{siteLabel(siteOf(passkey))}</Text>}
      description={
        <Text size="caption" tone="textSecondary" numberOfLines={1} style={DETAIL}>
          {accountOf(passkey)}
        </Text>
      }
      onPress={() => showSettingsSheet(<PasskeySheet passkey={passkey} />)}
    >
      {passkey.provider !== "ardia" ? <BrandBadge provider={passkey.provider} tooltip={nameOf(passkey.provider)} /> : null}
    </Row>
  );
});

function GrowingPasskeyRows({ passkeys, query }: { passkeys: readonly VaultPasskey[]; query: string }) {
  const rows = useGrowingRows(passkeys.length, `passkeys|${query}`);
  return (
    <View>
      {passkeys.slice(0, rows).map((passkey, i) => (
        <View key={keyOf(passkey)}>
          {i > 0 ? <Divider thick inset="l" /> : null}
          <PasskeyRow passkey={passkey} />
        </View>
      ))}
    </View>
  );
}

function AnimatedPasskeyRows({ passkeys }: { passkeys: readonly VaultPasskey[] }) {
  const { list, drop } = useListPresence(passkeys, keyOf);
  return (
    <View>
      {list.map((p, i) => (
        <Expand key={p.key} open={p.present} appear={p.appear} onClosed={() => drop(p.key)}>
          {i > 0 ? <Divider thick inset="l" /> : null}
          <PasskeyRow passkey={p.item} />
        </Expand>
      ))}
    </View>
  );
}

export function PasskeysSection({ query }: { query: string }) {
  const list = usePasskeys((s) => s.list);
  useEffect(() => void loadPasskeys(), []);
  const shown = useMemo(() => matchingPasskeys(list ?? [], query), [list, query]);
  return (
    <Expand open={shown.length > 0}>
      <SectionHeader title={`${COUNT.format(shown.length)} Passkey${shown.length === 1 ? "" : "s"}`} />
      <Group>{shown.length > ANIMATED_ROWS ? <GrowingPasskeyRows passkeys={shown} query={query} /> : <AnimatedPasskeyRows passkeys={shown} />}</Group>
    </Expand>
  );
}

export function PasskeySheet({ passkey }: { passkey: VaultPasskey }) {
  const nameOf = useManagerName();
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const live = usePasskeys((s) => s.list?.find((p) => keyOf(p) === keyOf(passkey)) ?? null);
  const ardia = passkey.provider === "ardia";
  const remove = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const { confirmed } = await confirm({
        title: `Delete the Passkey for ${siteLabel(siteOf(passkey))}?`,
        message: `You won't be able to sign in as ${accountOf(passkey)} with it. Keep another way to sign in before you delete it.`,
        confirmTitle: "Delete",
        destructive: true,
      });
      if (!confirmed) return;
      const outcome = await deletePasskey(passkey.id);
      if (outcome.ok) return closeSettingsSheet();
      setProblem(outcome.error ?? "");
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!live && !running.current) closeSettingsSheet();
  }, [live]);
  return (
    <Dialog width="m" maxHeight="90%" onDismiss={closeSettingsSheet} onSubmit={closeSettingsSheet}>
      <DialogTitle icon={<Favicon url={siteOf(passkey)} size={VAULT_SETTINGS.siteIcon} />} subtitle="Passkey">
        {siteLabel(siteOf(passkey))}
      </DialogTitle>
      <View style={BODY}>
        <Group>
          <Row title="Username">
            <Text numberOfLines={1} tone="textSecondary" selectable>
              {accountOf(passkey)}
            </Text>
          </Row>
          {passkey.displayName && passkey.displayName !== passkey.userName ? (
            <Row title="Name">
              <Text numberOfLines={1} tone="textSecondary">
                {passkey.displayName}
              </Text>
            </Row>
          ) : null}
          <Row title="Website">
            <Text numberOfLines={1} tone="textSecondary" selectable>
              {passkey.rpId}
            </Text>
          </Row>
          {passkey.createdAt ? (
            <Row title="Created">
              <Text tone="textSecondary">{DATE.format(new Date(passkey.createdAt))}</Text>
            </Row>
          ) : null}
          <Row title="Saved In">
            <Text tone="textSecondary">{nameOf(passkey.provider)}</Text>
          </Row>
        </Group>
        {ardia ? null : (
          <Text size="caption" tone="textSecondary" style={NOTE}>
            Ardia signs in with this passkey. Change or delete it in {nameOf(passkey.provider)}.
          </Text>
        )}
        <Expand open={!!problem} gap={space.ml}>
          <Text size="caption" tone="destructive">
            {problem}
          </Text>
        </Expand>
      </View>
      <DialogActions leading={ardia ? <Button title="Delete" kind="destructive" disabled={busy} onPress={() => void remove()} /> : undefined}>
        <Button title="Done" kind="primary" disabled={busy} onPress={closeSettingsSheet} />
      </DialogActions>
    </Dialog>
  );
}

const BODY = { marginTop: space.xl } as const;
const DETAIL = { marginTop: space.xxs } as const;
const NOTE = { marginTop: space.ml } as const;
