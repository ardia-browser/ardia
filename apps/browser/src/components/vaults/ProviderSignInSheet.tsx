import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { consentToken, type ConsentToken } from "../../state/telemetry/choice";
import { closeSettingsSheet } from "../../state/settings/sheet";
import { answerProvider, cancelProviderSignIn, openProviderApp, signInProvider, type VaultAnswer, type VaultSignInResult } from "../../state/vaults/actions";
import { fieldNamed, methodsOf, serversOf, titleOf, unlockFieldOf, type CredentialProviderState, type SignInMethod, type VaultNeeds } from "../../state/vaults/providerModel";
import { customServerURL, initialServer, serverValue, type ServerPick } from "../../state/vaults/servers";
import { canSubmit, errorAfter, needsOf, requestFor, retriedStep, SERVER_REFUSED, submitTitle, waitingLine, type Entries } from "../../state/vaults/signInFlow";
import { noteVaultSignIn, noteVaultTwoStep } from "../../state/telemetry/vaultCounts";
import { Button, Segmented, space, useSecretEntries } from "../ui";
import { FieldStack, OwnedSecretRow, WaitingNote, type StackRow } from "./SignInFields";
import { useNeedsStep } from "./SignInNeeds";
import { FieldError, PopUpRow, SignInSheet, TextRow, useFocusChain, useSignInRequest } from "./VaultSignInParts";

export type SignInPhase = "form" | "waiting" | "needs";
export type SignInPreview = { method?: string; phase?: SignInPhase; needs?: VaultNeeds; error?: string; busy?: boolean; server?: ServerPick; values?: Record<string, string> };

const prefilled = (methods: readonly SignInMethod[], account: string | undefined) => {
  const values: Record<string, string> = {};
  for (const field of methods.flatMap((m) => m.fields)) if (field.prefill && account) values[field.id] = account;
  return values;
};

const FIRST_FIELD = 1;

export function ProviderSignInSheet({ provider, preview }: { provider: CredentialProviderState; preview?: SignInPreview }) {
  const name = titleOf(provider);
  const methods = useMemo(() => methodsOf(provider), [provider.signIn, provider.setup]);
  const servers = useMemo(() => serversOf(provider), [provider.signIn]);
  const [methodId, setMethodId] = useState(preview?.method ?? methods[0]?.id ?? "");
  const method = methods.find((m) => m.id === methodId) ?? methods[0];
  const [server, setServer] = useState<ServerPick>(() => preview?.server ?? initialServer(servers, provider.server));
  const [values, setValues] = useState<Record<string, string>>(() => preview?.values ?? prefilled(methods, provider.account));
  const [lengths, setLengths] = useState<Record<string, number>>({});
  const tokens = useRef<Record<string, string>>({});
  const held = useSecretEntries();
  const [phase, setPhase] = useState<SignInPhase>(preview?.phase ?? (provider.needs ? "needs" : "form"));
  const [needs, setNeeds] = useState<VaultNeeds | null>(preview?.needs ?? provider.needs ?? null);
  const [slide, setSlide] = useState<-1 | 1>(1);
  const [busy, setBusy] = useState(preview?.busy ?? false);
  const [error, setError] = useState(preview?.error ?? "");
  const [serverError, setServerError] = useState("");
  const waiting = phase === "waiting";
  const request = useSignInRequest(provider.id, "connected", waiting || phase === "needs");
  const chain = useFocusChain(FIRST_FIELD + (method?.fields.length ?? 0));
  const chosen = servers.find((s) => s.id === server.id);
  const entries: Entries = { values, secretLengths: lengths };

  const pushed = useRef({ needs: provider.needs, problem: provider.problem?.message });
  useEffect(() => {
    const before = pushed.current;
    pushed.current = { needs: provider.needs, problem: provider.problem?.message };
    if (provider.needs && provider.needs !== before.needs && phase !== "form") {
      setNeeds(provider.needs);
      setPhase(provider.needs.kind === "approval" ? "waiting" : "needs");
    } else if (phase === "waiting" && !provider.needs && provider.problem?.message && provider.problem.message !== before.problem) {
      setSlide(-1);
      setPhase("form");
      setError(provider.problem.message);
    }
  }, [provider.needs, provider.problem?.message]);

  const settle = (result: VaultSignInResult, asked: VaultNeeds | null, consent: ConsentToken | null) => {
    if (result.ok) {
      noteVaultSignIn(true, false, false, consent);
      return closeSettingsSheet();
    }
    const next = needsOf(result);
    const said = errorAfter(result, name, asked);
    if (next) {
      if (next.kind === "code" && asked?.kind !== "code") noteVaultTwoStep(consent);
      const step = retriedStep(asked, next, said);
      setError(step.error);
      setSlide(1);
      setNeeds(step.needs);
      return setPhase(next.kind === "approval" ? "waiting" : "needs");
    }
    setError(said);
    noteVaultSignIn(false, false, false, consent);
    setSlide(-1);
    setNeeds(null);
    setPhase("form");
    if (result.field) setFocusField({ id: result.field, at: Date.now() });
  };

  const [focusField, setFocusField] = useState<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (!focusField || phase !== "form" || !method) return;
    const at = method.fields.findIndex((f) => f.id === focusField.id);
    if (at < 0) return;
    const frame = requestAnimationFrame(() => chain.at(FIRST_FIELD + at).current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusField, phase]);

  const submit = async () => {
    if (busy || !method) return;
    if (chosen?.custom && !customServerURL(server.url)) return setServerError(SERVER_REFUSED);
    if (!canSubmit(method, entries, true)) return;
    const consent = consentToken();
    setBusy(true);
    setError("");
    if (method.kind !== "credentials") {
      setSlide(1);
      setPhase("waiting");
    }
    const result = await request(() => signInProvider(provider.id, requestFor(method, entries, tokens.current, serverValue(servers, server))));
    setBusy(false);
    if (result) settle(result, null, consent);
  };

  const answer = async (reply: VaultAnswer) => {
    const consent = consentToken();
    const asked = needs;
    setBusy(true);
    setError("");
    const result = await request(() => answerProvider(provider.id, reply));
    setBusy(false);
    if (result) settle(result, asked, consent);
  };

  const back = () => {
    void cancelProviderSignIn(provider.id);
    held.dropAll();
    setLengths({});
    setSlide(-1);
    setBusy(false);
    setNeeds(null);
    setError("");
    setPhase("form");
  };

  const needsStep = useNeedsStep({
    needs: needs ?? { kind: "code" },
    busy,
    error,
    passwordTitle: unlockFieldOf(provider)?.title ?? null,
    field: fieldNamed(provider, needs?.field),
    onAnswer: (reply) => void answer(reply),
    onBack: back,
    onCancel: closeSettingsSheet,
    chain,
  });

  const sheet = { provider: provider.id, title: name, onCancel: closeSettingsSheet, slide };
  if (phase === "needs" && needs) {
    return (
      <SignInSheet {...sheet} subtitle={needs.message} step={`needs-${needs.kind}`} onSubmit={needsStep.submit} submitsFromSheet={needsStep.fromSheet} leading={needsStep.leading} primary={needsStep.primary}>
        {needsStep.body}
      </SignInSheet>
    );
  }
  if (!method) {
    return (
      <SignInSheet {...sheet} step="none" onSubmit={closeSettingsSheet} submitsFromSheet primary={null}>
        <FieldError text={`${name} can't sign in from this version of Ardia.`} standalone />
      </SignInSheet>
    );
  }
  if (phase === "waiting") {
    const app = method.kind === "desktopApproval" && method.appURL ? method.appURL : null;
    return (
      <SignInSheet
        {...sheet}
        step={`waiting-${needs?.kind ?? method.kind}`}
        onSubmit={() => app && openProviderApp(app)}
        submitsFromSheet
        leading={app ? <Button title={`Open ${method.appTitle || name}`} onPress={() => openProviderApp(app)} /> : undefined}
        primary={null}
      >
        <WaitingNote text={needs?.kind === "approval" && needs.message ? needs.message : waitingLine(method, name)} />
      </SignInSheet>
    );
  }

  const edit = () => error && setError("");
  const shared = { onSubmit: () => void submit(), onCancel: closeSettingsSheet, onTab: chain.move };
  const firstEmpty = method.fields.find((f) => !f.optional && !(f.type === "secret" ? lengths[f.id] : values[f.id]?.trim()))?.id;
  const serverRows: StackRow[] = servers.length
    ? [
        {
          key: "server",
          render: () => (
            <PopUpRow
              label="Server"
              value={server.id}
              options={servers.map((s) => ({ value: s.id, title: s.title }))}
              onChange={(id) => (setServer((now) => ({ ...now, id })), setServerError(""), edit())}
            />
          ),
        },
        ...(chosen?.custom
          ? [
              {
                key: "serverURL",
                render: () => (
                  <TextRow
                    label={chosen.custom!.title}
                    value={server.url}
                    onChange={(url) => (setServer((now) => ({ ...now, url })), setServerError(""), edit())}
                    placeholder={chosen.custom!.placeholder}
                    autoFocus={!server.url}
                    handle={chain.at(0)}
                    index={0}
                    {...shared}
                  />
                ),
              },
            ]
          : []),
      ]
    : [];
  const fieldRows: StackRow[] = method.fields.map((field, i) => {
    const index = FIRST_FIELD + i;
    const placeholder = field.placeholder ?? (field.optional ? "Optional" : "Required");
    const focus = field.id === firstEmpty && !(chosen?.custom && !server.url);
    if (field.type === "secret") {
      return {
        key: field.id,
        render: () => (
          <OwnedSecretRow
            fieldId={field.id}
            heldEntry={held.entryFor(field.id)}
            onEntry={(id, entry) => {
              if (entry) tokens.current[id] = entry;
              else delete tokens.current[id];
            }}
            label={field.title}
            placeholder={field.optional ? "Optional" : "Required"}
            revealed={field.revealed}
            autoFocus={focus}
            onLength={(n) => (setLengths((now) => ({ ...now, [field.id]: n })), edit())}
            handle={chain.at(index)}
            index={index}
            {...shared}
          />
        ),
      };
    }
    return {
      key: field.id,
      render: () => (
        <TextRow
          label={field.title}
          value={values[field.id] ?? ""}
          onChange={(text) => (setValues((now) => ({ ...now, [field.id]: text })), edit())}
          placeholder={placeholder}
          mono={field.type === "code"}
          autoFocus={focus}
          handle={chain.at(index)}
          index={index}
          {...shared}
        />
      ),
    };
  });
  const ready = canSubmit(method, entries, !chosen?.custom || !!server.url.trim());
  const app = method.kind === "desktopApproval" && method.appURL ? method.appURL : null;
  return (
    <SignInSheet
      {...sheet}
      step="form"
      onSubmit={() => void submit()}
      submitsFromSheet={!fieldRows.length && !chosen?.custom}
      leading={app ? <Button title={`Open ${method.appTitle || name}`} onPress={() => openProviderApp(app)} /> : undefined}
      primary={<Button title={submitTitle(method)} kind="primary" busy={busy} disabled={!ready} onPress={() => void submit()} />}
    >
      {methods.length > 1 ? (
        <View style={PICKER}>
          <Segmented fill options={methods.map((m) => ({ value: m.id, title: m.title }))} value={method.id} onChange={(id) => (setMethodId(id), setError(""))} />
        </View>
      ) : null}
      {serverRows.length ? <FieldStack rows={serverRows} /> : null}
      {fieldRows.length ? <FieldStack rows={fieldRows} /> : null}
      {serverError || error ? <FieldError text={serverError || error} standalone /> : null}
    </SignInSheet>
  );
}

const PICKER = { marginTop: space.xl } as const;
