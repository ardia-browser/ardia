import { consentToken } from "../../../state/telemetry/choice";
import { useState } from "react";
import { closeSettingsSheet } from "../../../state/settings/sheet";
import { configureProvider, signInProvider, type VaultProviderState, type VaultSignInFields } from "../../../state/vaults/actions";
import { bitwardenServer, serverChoiceOf, type ServerChoice } from "../../../state/vaults/servers";
import {
  canSubmitCode,
  chooseCodeMethod,
  codeError,
  codePrompt,
  codeStepAfter,
  codeSubmitTitle,
  placeSignInError,
  sendsEmail,
  type CodeStep,
  type FieldError,
  type SignInField,
} from "../../../state/vaults/signInFlow";
import { noteVaultSignIn, noteVaultTwoStep } from "../../../state/telemetry/vaultCounts";
import { Button, useSecretEntry } from "../../ui";
import { errorFor, FieldError as FieldErrorText, Form, PopUpRow, SecretRow, SignInSheet, TextRow, TouchIdRow, useFocusChain, useSignInRequest } from "../../vaults/VaultSignInParts";

const SERVER_OPTIONS: { value: ServerChoice; title: string }[] = [
  { value: "us", title: "Bitwarden.com" },
  { value: "eu", title: "Bitwarden.eu" },
  { value: "self", title: "Self-Hosted" },
];

const NO_ERROR: FieldError = { field: null, text: "" };
const CODE_TITLES = ["Continue", "Send Code"] as const;
const LOGIN_FIELDS = new Set<SignInField>(["server", "email", "password"]);
const API_KEY_FIELDS = new Set<SignInField>(["server", "clientId", "clientSecret", "password"]);
const CODE_FIELDS = new Set<SignInField>(["code"]);
const FOCUS = { url: 0, account: 1, secret: 2, password: 3, code: 4 } as const;

export function BitwardenSheet({ provider }: { provider: VaultProviderState }) {
  const [choice, setChoice] = useState<ServerChoice>(() => serverChoiceOf(provider.server));
  const [url, setUrl] = useState(() => (serverChoiceOf(provider.server) === "self" ? (provider.server ?? "") : ""));
  const [apiKey, setApiKey] = useState(false);
  const [email, setEmail] = useState(provider.account ?? "");
  const [clientId, setClientId] = useState("");
  const passwordEntry = useSecretEntry();
  const secretEntry = useSecretEntry();
  const [passwordLength, setPasswordLength] = useState(0);
  const [secretLength, setSecretLength] = useState(0);
  const [code, setCode] = useState("");
  const [codeStep, setCodeStep] = useState<CodeStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FieldError>(NO_ERROR);
  const chain = useFocusChain(5);
  const request = useSignInRequest(provider.id, "connected");
  const server = bitwardenServer(choice, url);
  const stage = codeStep ? "code" : apiKey ? "apiKey" : "login";
  const ready = codeStep
    ? canSubmitCode(codeStep, code)
    : passwordLength > 0 && (choice !== "self" || !!server) && (apiKey ? !!clientId.trim() && secretLength > 0 : !!email.trim());

  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    if (error.text) setError(NO_ERROR);
  };

  const submit = async () => {
    if (!ready || busy) return;
    const consent = consentToken();
    setBusy(true);
    setError(NO_ERROR);
    if (!codeStep && (server ?? null) !== (provider.server ?? null)) await configureProvider(provider.id, server);
    const fields: VaultSignInFields = apiKey
      ? { clientId: clientId.trim(), clientSecretEntry: secretEntry, passwordEntry, ...(server ? { server } : {}) }
      : { email: email.trim(), passwordEntry, ...(server ? { server } : {}) };
    if (codeStep) Object.assign(fields, { ...(code.trim() && !sendsEmail(codeStep) ? { code: code.trim() } : {}), ...(codeStep.method ? { method: codeStep.method } : {}) });
    const result = await request(() => signInProvider(provider.id, fields));
    setBusy(false);
    if (!result) return;
    noteVaultSignIn(result.ok, false, false, consent);
    if (result.ok) return closeSettingsSheet();
    const next = codeStepAfter(result, codeStep);
    if (next && !codeStep) noteVaultTwoStep(consent);
    setError(next || codeStep ? codeError(result, provider.name, codeStep) : placeSignInError(result, provider.name, stage));
    if (next !== codeStep) {
      if (!codeStep || next?.emailSent) setCode("");
      setCodeStep(next);
    }
  };

  const back = () => {
    setCodeStep(null);
    setCode("");
    setError(NO_ERROR);
  };

  const shown = codeStep ? CODE_FIELDS : apiKey ? API_KEY_FIELDS : LOGIN_FIELDS;
  const general = error.text && (!error.field || !shown.has(error.field)) ? error.text : "";
  const rowProps = { onSubmit: () => void submit(), onCancel: closeSettingsSheet, onTab: chain.move };

  if (codeStep) {
    const methodOptions = codeStep.methods.map((m) => ({ value: m.id, title: m.name }));
    const asksCode = !sendsEmail(codeStep);
    return (
      <SignInSheet
        provider={provider.id}
        title={provider.name}
        subtitle={codePrompt(codeStep)}
        step="code"
        onCancel={closeSettingsSheet}
        onSubmit={() => void submit()}
        submitsFromSheet={!asksCode}
        leading={<Button title="Back" disabled={busy} onPress={back} />}
        primary={<Button title={codeSubmitTitle(codeStep)} reserve={CODE_TITLES} kind="primary" busy={busy} disabled={!ready} onPress={() => void submit()} />}
      >
        {methodOptions.length > 1 || asksCode ? (
          <Form>
            {methodOptions.length > 1 ? (
              <PopUpRow
                label="Method"
                value={codeStep.method}
                options={methodOptions}
                onChange={(m) => {
                  setCodeStep(chooseCodeMethod(codeStep, m));
                  setCode("");
                  setError(NO_ERROR);
                }}
              />
            ) : null}
            {asksCode ? (
              <TextRow key={codeStep.method} label="Code" value={code} onChange={edit(setCode)} mono autoFocus error={errorFor("code", error)} handle={chain.at(FOCUS.code)} index={FOCUS.code} {...rowProps} />
            ) : null}
          </Form>
        ) : null}
        {general ? <FieldErrorText text={general} standalone /> : null}
      </SignInSheet>
    );
  }

  return (
    <SignInSheet
      provider={provider.id}
      title={provider.name}
      step={stage}
      onCancel={closeSettingsSheet}
      onSubmit={() => void submit()}
      leading={
        <Button
          title={apiKey ? "Use Password" : "Use API Key"}
          disabled={busy}
          onPress={() => {
            setError(NO_ERROR);
            setApiKey(!apiKey);
          }}
        />
      }
      primary={<Button title="Sign In" kind="primary" busy={busy} disabled={!ready} onPress={() => void submit()} />}
    >
      <Form>
        <PopUpRow
          label="Server"
          value={choice}
          options={SERVER_OPTIONS}
          onChange={edit(setChoice)}
          error={choice === "self" ? undefined : errorFor("server", error)}
        />
        {choice === "self" ? (
          <TextRow label="Server URL" value={url} onChange={edit(setUrl)} placeholder="vault.example.com" autoFocus={!url} error={errorFor("server", error)} handle={chain.at(FOCUS.url)} index={FOCUS.url} {...rowProps} />
        ) : null}
      </Form>
      <Form>
        {apiKey ? (
          <TextRow label="Client ID" value={clientId} onChange={edit(setClientId)} placeholder="user.…" autoFocus error={errorFor("clientId", error)} handle={chain.at(FOCUS.account)} index={FOCUS.account} {...rowProps} />
        ) : (
          <TextRow label="Email" value={email} onChange={edit(setEmail)} placeholder="name@example.com" autoFocus={!email && choice !== "self"} error={errorFor("email", error)} handle={chain.at(FOCUS.account)} index={FOCUS.account} {...rowProps} />
        )}
        {apiKey ? (
          <SecretRow label="Client Secret" entry={secretEntry} onLength={edit(setSecretLength)} error={errorFor("clientSecret", error)} handle={chain.at(FOCUS.secret)} index={FOCUS.secret} {...rowProps} />
        ) : null}
        <SecretRow
          label="Master Password"
          entry={passwordEntry}
          onLength={edit(setPasswordLength)}
          autoFocus={!apiKey && !!email && choice !== "self"}
          error={errorFor("password", error)}
          handle={chain.at(FOCUS.password)}
          index={FOCUS.password}
          {...rowProps}
        />
      </Form>
      {general ? <FieldErrorText text={general} standalone /> : null}
      <TouchIdRow available={provider.capabilities.touchID} />
    </SignInSheet>
  );
}
