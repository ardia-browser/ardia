import { useEffect, useState } from "react";
import { View } from "react-native";
import { useAppActive } from "../../state/app/appActive";
import { confirm, showMenu } from "../../state/app/system";
import { codeAt, type VaultTotp } from "../../state/vaults/codes";
import type { VaultItem } from "../../state/vaults/types";
import { codeSetupChoices, copyArdiaCode, readArdiaCode, currentCodePageTab, removeArdiaCode, setUpArdiaCode, type CodeOutcome } from "../../state/vaults/ardiaCodes";
import { loginName } from "../../state/vaults/totpSetupModel";
import { Button, space } from "../ui";
import { Row } from "../settings/Form";
import { itemKey } from "../../state/vaults/originMatch";
import { CodeDigits } from "./CodeDigits";
import { CopyButton, CountdownRing } from "./VaultParts";
import { VAULT_CODE } from "./tokens";

export function useLiveCode(item: Pick<VaultItem, "provider" | "id" | "hasTotp">): VaultTotp | null {
  const owner = itemKey(item);
  const [live, setLive] = useState<{ owner: string; code: VaultTotp } | null>(null);
  const active = useAppActive();
  useEffect(() => {
    const setCode = (code: VaultTotp | null) => setLive(code ? { owner, code } : null);
    if (item.hasTotp !== true) return setCode(null);
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (shown: VaultTotp) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const rotated = codeAt(shown, Date.now());
        if (rotated && rotated !== shown) {
          setCode(rotated);
          schedule(rotated);
        }
        void load();
      }, Math.max(0, shown.expiresAt - Date.now()));
    };
    const load = async () => {
      const next = await readArdiaCode(item);
      if (!alive) return;
      setCode(next);
      if (next) schedule(next);
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [owner, item.hasTotp, active]);
  return live?.owner === owner ? live.code : null;
}

function CodeReadout({ owner, code, onCopy }: { owner: string; code: VaultTotp | null; onCopy: () => Promise<"copied" | "failed"> }) {
  const active = useAppActive();
  return (
    <View style={READOUT}>
      <View style={RING_SLOT}>{code ? <CountdownRing key={code.expiresAt} expiresAt={code.expiresAt} period={code.period} paused={!active} size={VAULT_CODE.sheetRing} stroke={VAULT_CODE.sheetStroke} /> : null}</View>
      <CodeDigits owner={owner} code={code} />
      <View style={COPY_SLOT}>
        <CopyButton label="Code" onCopy={onCopy} />
      </View>
    </View>
  );
}

export function LiveCode({ item, onCopy }: { item: Pick<VaultItem, "provider" | "id" | "hasTotp">; onCopy: () => Promise<"copied" | "failed"> }) {
  return <CodeReadout owner={itemKey(item)} code={useLiveCode(item)} onCopy={onCopy} />;
}

export function ArdiaCodeRow({ item, editing, onProblem }: { item: VaultItem; editing: boolean; onProblem: (text: string) => void }) {
  const code = useLiveCode(item);
  const [busy, setBusy] = useState(false);
  const settle = (outcome: CodeOutcome) => onProblem(outcome.ok ? "" : (outcome.error ?? ""));
  const run = async (work: () => Promise<CodeOutcome>) => {
    if (busy) return;
    setBusy(true);
    onProblem("");
    settle(await work().finally(() => setBusy(false)));
  };
  const setUp = () =>
    run(async () => {
      const origin = item.urls[0] ?? "";
      const tabId = currentCodePageTab(origin);
      const choices = codeSetupChoices(origin, tabId);
      const picked = await showMenu(choices);
      const choice = choices.find((c) => c.id === picked);
      return choice ? setUpArdiaCode(item, choice.id, tabId) : { ok: false, error: null };
    });
  const remove = () =>
    run(async () => {
      const { confirmed } = await confirm({
        title: `Remove the verification code for ${loginName(item)}?`,
        message: "Ardia will stop filling codes for this login. Turn off two-factor authentication on the site first, or keep another way to get codes.",
        confirmTitle: "Remove",
        destructive: true,
      });
      return confirmed ? removeArdiaCode(item) : { ok: false, error: null };
    });

  if (item.hasTotp !== true) {
    return (
      <Row title="Verification Code">
        <Button title="Set Up…" disabled={busy} onPress={() => void setUp()} />
      </Row>
    );
  }
  return (
    <Row title="Verification Code">
      {editing ? (
        <Button title="Remove" kind="destructive" disabled={busy} onPress={() => void remove()} />
      ) : (
        <CodeReadout owner={itemKey(item)} code={code} onCopy={async () => ((await copyArdiaCode(item)) ? "copied" : "failed")} />
      )}
    </Row>
  );
}

const READOUT = { flexDirection: "row", alignItems: "center" } as const;
const RING_SLOT = { width: VAULT_CODE.sheetRing, height: VAULT_CODE.sheetRing, marginRight: VAULT_CODE.ringGap } as const;
const COPY_SLOT = { marginLeft: space.xs } as const;
