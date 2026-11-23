import { useEffect, useRef, useState } from "react";
import { consentToken } from "../../../state/telemetry/choice";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import {
  copyInstallCommand,
  installCommandOf,
  openApprovalPage,
  openProviderApp,
  refreshProvider,
  signInProvider,
  unlockProvider,
  type VaultProviderState,
} from "../../../state/vaults/actions";
import { useVaultProvider } from "../../../state/vaults/hooks";
import { installCheckError, placeSignInError, protonFailure, type FieldError } from "../../../state/vaults/signInFlow";
import { noteVaultCliCheck, noteVaultSignIn } from "../../../state/telemetry/vaultCounts";
import { Button, Toggle, useSecretEntry } from "../../ui";
import { CommandRow, errorFor, FieldError as FieldErrorText, Form, NoteRow, SecretRow, SheetLine, SignInSheet, TouchIdRow, useFocusChain, useSignInRequest } from "../../vaults/VaultSignInParts";
import { BitwardenSheet } from "./BitwardenSheet";

export const showConnectSheet = (provider: string) => showSettingsSheet(<ConnectSheet provider={provider} />);
export const showUnlockSheet = (provider: string) => showSettingsSheet(<UnlockSheet provider={provider} />);

export const UNLOCK_TITLES = ["Unlock", "Unlocking…"] as const;

const NO_ERROR: FieldError = { field: null, text: "" };

function useCloseWhenUnlocked(provider: VaultProviderState | undefined) {
  const was = useRef(provider?.state);
  useEffect(() => {
    if (provider?.state === "unlocked" && was.current !== "unlocked") closeSettingsSheet();
    was.current = provider?.state;
  }, [provider?.state]);
}

function ConnectSheet({ provider: id }: { provider: string }) {
  const provider = useVaultProvider(id);
  useCloseWhenUnlocked(provider);
  if (!provider) return null;
  if (provider.state === "notInstalled") return <InstallSheet provider={provider} />;
  switch (provider.setup?.kind) {
    case "desktopIntegration":
      return <OnePasswordSheet provider={provider} />;
    case "browserSignIn":
      return <ProtonPassSheet provider={provider} />;
    default:
      return <BitwardenSheet provider={provider} />;
  }
}

function InstallSheet({ provider }: { provider: VaultProviderState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const check = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    noteVaultCliCheck();
    const state = await refreshProvider(provider.id);
    setBusy(false);
    setError(installCheckError(!state || state.state === "notInstalled", provider.name));
  };
  const guide = provider.install?.url;
  return (
    <SignInSheet
      provider={provider.id}
      title={provider.name}
      subtitle="Install the command-line tool in Terminal."
      step="install"
      onCancel={closeSettingsSheet}
      onSubmit={() => void check()}
      submitsFromSheet
      leading={guide ? <Button title="Install Guide" onPress={() => openProviderApp(guide)} /> : undefined}
      primary={<Button title="Check Again" kind="primary" busy={busy} onPress={() => void check()} />}
    >
      <Form>
        <CommandRow command={installCommandOf(provider)} onCopy={() => copyInstallCommand(installCommandOf(provider))} />
      </Form>
      {error ? <FieldErrorText text={error} standalone /> : null}
    </SignInSheet>
  );
}

function OnePasswordSheet({ provider }: { provider: VaultProviderState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useSignInRequest(provider.id, "connected");
  const proceed = async () => {
    if (busy) return;
    const consent = consentToken();
    setBusy(true);
    setError("");
    const result = await request(() => unlockProvider(provider.id, null));
    setBusy(false);
    if (!result) return;
    noteVaultSignIn(result.ok, false, false, consent);
    if (result.ok) return closeSettingsSheet();
    setError(placeSignInError(result, provider.name, "approval").text);
  };
  const app = provider.setup?.appURL;
  return (
    <SignInSheet
      provider={provider.id}
      title={provider.name}
      subtitle={busy ? "Approve Ardia in 1Password." : "Turn this on in 1Password, then continue."}
      step="approve"
      onCancel={closeSettingsSheet}
      onSubmit={() => void proceed()}
      submitsFromSheet
      leading={app ? <Button title="Open 1Password" onPress={() => openProviderApp(app)} /> : undefined}
      primary={<Button title="Continue" kind="primary" busy={busy} onPress={() => void proceed()} />}
    >
      <Form>
        <NoteRow title="Integrate with 1Password CLI" detail="Settings › Developer" trailing={<Toggle value disabled accessibilityLabel="Integrate with 1Password CLI" onChange={() => {}} />} />
      </Form>
      {error ? <FieldErrorText text={error} standalone /> : null}
    </SignInSheet>
  );
}

type ProtonMode = "browser" | "waiting" | "token";

function ProtonPassSheet({ provider }: { provider: VaultProviderState }) {
  const [mode, setMode] = useState<ProtonMode>("browser");
  const token = useSecretEntry();
  const [tokenLength, setTokenLength] = useState(0);
  const [approvalURL, setApprovalURL] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FieldError>(NO_ERROR);
  const chain = useFocusChain(1);
  const failure = mode === "waiting" && provider.state === "signedOut" ? protonFailure(provider.message) : "";
  const request = useSignInRequest(provider.id, "connected", mode === "waiting");
  useEffect(() => {
    if (!failure) return;
    setMode("browser");
    setError({ field: null, text: failure });
  }, [failure]);
  const begin = async () => {
    if (busy) return;
    const consent = consentToken();
    setBusy(true);
    setError(NO_ERROR);
    const result = await request(() => signInProvider(provider.id, {}));
    setBusy(false);
    if (!result) return;
    if (result.ok) return closeSettingsSheet();
    if (result.needs === "approval" && result.approvalURL) {
      setApprovalURL(result.approvalURL);
      openApprovalPage(result.approvalURL);
      return setMode("waiting");
    }
    noteVaultSignIn(false, false, false, consent);
    setError(placeSignInError(result, provider.name, "approval"));
  };
  const withToken = async () => {
    if (busy || !tokenLength) return;
    const consent = consentToken();
    setBusy(true);
    setError(NO_ERROR);
    const result = await request(() => signInProvider(provider.id, { method: "accessToken", clientSecretEntry: token }));
    setBusy(false);
    if (!result) return;
    noteVaultSignIn(result.ok, false, false, consent);
    if (result.ok) return closeSettingsSheet();
    setError(placeSignInError(result, provider.name, "token"));
  };
  const cancel = () => closeSettingsSheet();
  const switchTo = (next: ProtonMode) => {
    setError(NO_ERROR);
    setMode(next);
  };
  const general = error.text && error.field !== "token" ? error.text : "";
  if (mode === "token")
    return (
      <SignInSheet
        provider={provider.id}
        title={provider.name}
        step="token"
        onCancel={cancel}
        onSubmit={() => void withToken()}
        leading={<Button title="Use Browser" disabled={busy} onPress={() => switchTo("browser")} />}
        primary={<Button title="Sign In" kind="primary" busy={busy} disabled={!tokenLength} onPress={() => void withToken()} />}
      >
        <Form>
          <SecretRow
            label="Access Token"
            entry={token}
            autoFocus
            onLength={(n) => (setTokenLength(n), error.text && setError(NO_ERROR))}
            error={errorFor("token", error)}
            onSubmit={() => void withToken()}
            onCancel={cancel}
            handle={chain.at(0)}
            index={0}
            onTab={chain.move}
          />
        </Form>
        {general ? <FieldErrorText text={general} standalone /> : null}
      </SignInSheet>
    );
  if (mode === "waiting")
    return (
      <SignInSheet
        provider={provider.id}
        title={provider.name}
        subtitle="Finish signing in to Proton in your browser."
        step="waiting"
        onCancel={cancel}
        onSubmit={() => openApprovalPage(approvalURL)}
        submitsFromSheet
        primary={<Button title="Open Browser Again" kind="primary" onPress={() => openApprovalPage(approvalURL)} />}
      >
        <SheetLine>Ardia connects as soon as you're done.</SheetLine>
      </SignInSheet>
    );
  return (
    <SignInSheet
      provider={provider.id}
      title={provider.name}
      subtitle="Sign in to Proton in your browser."
      step="browser"
      onCancel={cancel}
      onSubmit={() => void begin()}
      submitsFromSheet
      leading={<Button title="Use Access Token" disabled={busy} onPress={() => switchTo("token")} />}
      primary={<Button title="Continue" kind="primary" busy={busy} onPress={() => void begin()} />}
    >
      {general ? <FieldErrorText text={general} standalone /> : null}
    </SignInSheet>
  );
}

function UnlockSheet({ provider: id }: { provider: string }) {
  const provider = useVaultProvider(id);
  const password = useSecretEntry();
  const [length, setLength] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FieldError>(NO_ERROR);
  const chain = useFocusChain(1);
  const request = useSignInRequest(id, "unlocked");
  useCloseWhenUnlocked(provider);
  if (!provider) return null;
  const unlock = async () => {
    if (!length || busy) return;
    const consent = consentToken();
    setBusy(true);
    setError(NO_ERROR);
    const result = await request(() => unlockProvider(provider.id, password));
    setBusy(false);
    if (!result) return;
    noteVaultSignIn(result.ok, true, result.entryExpired === true, consent);
    if (result.ok) return closeSettingsSheet();
    const placed = placeSignInError(result, provider.name, "unlock");
    setError(placed);
    if (placed.field === "password") chain.at(0).current?.focus();
  };
  return (
    <SignInSheet
      provider={provider.id}
      title={provider.name}
      subtitle={provider.account ?? undefined}
      step="unlock"
      onCancel={closeSettingsSheet}
      onSubmit={() => void unlock()}
      primary={<Button title="Unlock" kind="primary" busy={busy} disabled={!length} onPress={() => void unlock()} />}
    >
      <Form>
        <SecretRow
          label="Master Password"
          entry={password}
          autoFocus
          onLength={(n) => (setLength(n), error.text && setError(NO_ERROR))}
          error={errorFor("password", error)}
          onSubmit={() => void unlock()}
          onCancel={closeSettingsSheet}
          handle={chain.at(0)}
          index={0}
          onTab={chain.move}
        />
      </Form>
      {error.text && error.field !== "password" ? <FieldErrorText text={error.text} standalone /> : null}
      <TouchIdRow available={provider.capabilities.touchID} />
    </SignInSheet>
  );
}
