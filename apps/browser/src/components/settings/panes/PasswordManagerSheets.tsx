import { useEffect, useRef, useState } from "react";
import { consentToken } from "../../../state/telemetry/choice";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { copyInstallCommand, openProviderApp, refreshProvider, unlockProvider } from "../../../state/vaults/actions";
import { useVaultProvider } from "../../../state/vaults/hooks";
import { managerStatus } from "../../../state/vaults/managerStatus";
import { credential, titleOf, unlockFieldOf, type CredentialProviderState } from "../../../state/vaults/providerModel";
import { installCheckError, signInMessage } from "../../../state/vaults/signInFlow";
import { noteVaultCliCheck, noteVaultSignIn } from "../../../state/telemetry/vaultCounts";
import { Button, useSecretEntry } from "../../ui";
import { ProviderSignInSheet, type SignInPreview } from "../../vaults/ProviderSignInSheet";
import { CommandRow, FieldError as FieldErrorText, Form, SecretRow, SignInSheet, useFocusChain, useSignInRequest } from "../../vaults/VaultSignInParts";

export const showConnectSheet = (provider: string, preview?: SignInPreview) => showSettingsSheet(<ConnectSheet provider={provider} preview={preview} />);
export const showUnlockSheet = (provider: string, preview?: { error?: string }) => showSettingsSheet(<UnlockSheet provider={provider} preview={preview} />);

const connected = (state: string | undefined) => state === "unlocked" || state === "locked";

function useCloseWhenReached(state: string | undefined, reached: (state: string | undefined) => boolean) {
  const was = useRef(state);
  useEffect(() => {
    if (reached(state) && !reached(was.current)) closeSettingsSheet();
    was.current = state;
  }, [state]);
}

function ConnectSheet({ provider: id, preview }: { provider: string; preview?: SignInPreview }) {
  const state = useVaultProvider(id);
  useCloseWhenReached(state?.state, connected);
  if (!state) return null;
  const provider = credential(state);
  if (managerStatus(provider).command) return <InstallSheet provider={provider} />;
  return <ProviderSignInSheet provider={provider} preview={preview} />;
}

function InstallSheet({ provider }: { provider: CredentialProviderState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = titleOf(provider);
  const status = managerStatus(provider);
  const command = status.command ?? "";
  const check = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    noteVaultCliCheck();
    const state = await refreshProvider(provider.id);
    setBusy(false);
    const still = !state || !!managerStatus(credential(state)).command;
    setError(still && provider.state !== "notInstalled" ? status.line : installCheckError(still, name));
  };
  const guide = provider.install?.url;
  return (
    <SignInSheet
      provider={provider.id}
      title={name}
      subtitle={provider.state === "notInstalled" ? undefined : status.line}
      step="install"
      onCancel={closeSettingsSheet}
      onSubmit={() => void check()}
      submitsFromSheet
      leading={guide ? <Button title="Install Guide" onPress={() => openProviderApp(guide)} /> : undefined}
      primary={<Button title="Check Again" kind="primary" busy={busy} onPress={() => void check()} />}
    >
      <Form>
        <CommandRow command={command} onCopy={() => copyInstallCommand(command)} />
      </Form>
      {error ? <FieldErrorText text={error} standalone /> : null}
    </SignInSheet>
  );
}

const NO_ERROR = { field: null, text: "" } as const;

function UnlockSheet({ provider: id, preview }: { provider: string; preview?: { error?: string } }) {
  const state = useVaultProvider(id);
  const password = useSecretEntry();
  const [length, setLength] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: "password" | null; text: string }>(preview?.error ? { field: "password", text: preview.error } : NO_ERROR);
  const chain = useFocusChain(1);
  const request = useSignInRequest(id, "unlocked");
  useCloseWhenReached(state?.state, (s) => s === "unlocked");
  if (!state) return null;
  const provider = credential(state);
  const name = titleOf(provider);
  const label = unlockFieldOf(provider)?.title ?? "Password";
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
    setError({ field: "password", text: signInMessage(result, name) });
    chain.at(0).current?.focus();
  };
  return (
    <SignInSheet
      provider={provider.id}
      title={name}
      subtitle={provider.account ?? undefined}
      step="unlock"
      onCancel={closeSettingsSheet}
      onSubmit={() => void unlock()}
      primary={<Button title="Unlock" kind="primary" busy={busy} disabled={!length} onPress={() => void unlock()} />}
    >
      <Form>
        <SecretRow
          label={label}
          entry={password}
          autoFocus
          onLength={(n) => (setLength(n), error.text && setError(NO_ERROR))}
          onSubmit={() => void unlock()}
          onCancel={closeSettingsSheet}
          handle={chain.at(0)}
          index={0}
          onTab={chain.move}
        />
      </Form>
      {error.text ? <FieldErrorText text={error.text} standalone /> : null}
    </SignInSheet>
  );
}
