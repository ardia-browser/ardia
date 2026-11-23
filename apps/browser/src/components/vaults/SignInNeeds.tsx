import { useEffect, useRef, useState, type ReactNode } from "react";
import type { VaultAnswer } from "../../state/vaults/actions";
import type { SignInField, VaultNeeds } from "../../state/vaults/providerModel";
import { needLabel } from "../../state/vaults/signInFlow";
import { Button } from "../ui";
import { FieldStack, OwnedSecretRow, WaitingNote, type StackRow } from "./SignInFields";
import { FieldError, PopUpRow, TextRow, type useFocusChain } from "./VaultSignInParts";

type Chain = ReturnType<typeof useFocusChain>;

export type NeedsStep = { body: ReactNode; primary: ReactNode; leading: ReactNode; submit: () => void; fromSheet: boolean };

const APPROVE_IN_BROWSER = "Approve in your browser.";
const SUBMIT_TITLES = ["Continue", "Send Code"] as const;

export function useNeedsStep({
  needs,
  busy,
  error,
  passwordTitle,
  field,
  onAnswer,
  onBack,
  onCancel,
  chain,
}: {
  needs: VaultNeeds;
  busy: boolean;
  error: string;
  passwordTitle: string | null;
  field: SignInField | null;
  onAnswer: (answer: VaultAnswer) => void;
  onBack: () => void;
  onCancel: () => void;
  chain: Chain;
}): NeedsStep {
  const [text, setText] = useState("");
  const [secretLength, setSecretLength] = useState(0);
  const secret = useRef<string | null>(null);
  const [method, setMethod] = useState(needs.methods?.[0]?.id ?? "");
  const [account, setAccount] = useState(needs.accounts?.[0]?.id ?? "");
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  const asked = useRef(needs);
  if (asked.current !== needs) {
    asked.current = needs;
    if (needs.methods?.length && !needs.methods.some((m) => m.id === method)) setMethod(needs.methods[0]!.id);
    if (needs.accounts?.length && !needs.accounts.some((a) => a.id === account)) setAccount(needs.accounts[0]!.id);
  }
  useEffect(() => {
    if (!error || busy) return;
    const frame = requestAnimationFrame(() => chain.at(0).current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [error, busy]);
  const label = needLabel(needs, passwordTitle, field?.title ?? null);
  const secretNeed = needs.kind === "password" || (needs.kind === "field" && field?.type === "secret");
  const sendsFirst = needs.kind === "code" && !!needs.methods?.find((m) => m.id === method)?.sendsCode && !sent.has(method);
  const optional = needs.kind === "field" && !!field?.optional;
  const ready = sendsFirst || optional || (secretNeed ? secretLength > 0 : needs.kind === "account" ? !!account : text.trim().length > 0);

  const submit = () => {
    if (busy || !ready) return;
    if (sendsFirst) {
      setSent((now) => new Set(now).add(method));
      onAnswer({ need: "code", methodId: method });
    } else if (needs.kind === "code") onAnswer({ need: "code", value: text.trim(), ...(method ? { methodId: method } : {}) });
    else if (secretNeed) onAnswer({ need: needs.kind, ...(secret.current && secretLength ? { entryToken: secret.current } : {}) });
    else if (needs.kind === "email" || needs.kind === "field") onAnswer({ need: needs.kind, value: text.trim() });
    else if (needs.kind === "account") onAnswer({ need: "account", accountId: account });
  };

  const back = <Button title="Back" disabled={busy} onPress={onBack} />;
  if (needs.kind === "approval") {
    return { body: <WaitingNote text={needs.message || APPROVE_IN_BROWSER} />, primary: null, leading: back, submit: () => {}, fromSheet: true };
  }

  const shared = { onSubmit: submit, onCancel, onTab: chain.move };
  const rows: StackRow[] = [];
  if (needs.kind === "code" && (needs.methods?.length ?? 0) > 1) {
    rows.push({
      key: "method",
      render: () => (
        <PopUpRow
          label="Method"
          value={method}
          options={needs.methods!.map((m) => ({ value: m.id, title: m.title }))}
          onChange={(next) => {
            setMethod(next);
            setText("");
          }}
        />
      ),
    });
  }
  if (needs.kind === "account") {
    rows.push({ key: "account", render: () => <PopUpRow label={label} value={account} options={(needs.accounts ?? []).map((a) => ({ value: a.id, title: a.title }))} onChange={setAccount} /> });
  } else if (secretNeed) {
    rows.push({
      key: `secret-${field?.id ?? "password"}`,
      render: () => (
        <OwnedSecretRow
          fieldId={field?.id ?? "password"}
          placeholder={optional ? "Optional" : "Required"}
          revealed={field?.revealed}
          onEntry={(_, entry) => void (secret.current = entry)}
          label={label}
          autoFocus
          onLength={setSecretLength}
          handle={chain.at(0)}
          index={0}
          {...shared}
        />
      ),
    });
  } else if (!sendsFirst) {
    rows.push({
      key: `${needs.kind}-${method}`,
      render: () => <TextRow label={label} value={text} onChange={setText} placeholder={field?.placeholder} mono={needs.kind === "code" || field?.type === "code"} autoFocus handle={chain.at(0)} index={0} {...shared} />,
    });
  }
  return {
    body: (
      <>
        {rows.length ? <FieldStack rows={rows} /> : null}
        {error ? <FieldError text={error} standalone /> : null}
      </>
    ),
    primary: <Button title={sendsFirst ? "Send Code" : "Continue"} reserve={SUBMIT_TITLES} kind="primary" busy={busy} disabled={!ready} onPress={submit} />,
    leading: back,
    submit,
    fromSheet: needs.kind === "account" || (sendsFirst && rows.length === 0),
  };
}
