import { Button } from "../../ui";
import { APP } from "../model";
import { ErrorText, Handoff, Spacer, Title } from "../Parts";
import { backTo, canGoBackToChoose, importsBySpaces, runStepLabel, type ImportFlow } from "../../../state/import/flow";
import { skipEncryptedData, unlockAndImport } from "../../../state/import/runImport";

export function UnlockBody({ flow }: { flow: ImportFlow }) {
  const { source, sourceProfiles, step } = flow;
  if (!source || step.name !== "unlock") return null;
  const { error } = step;
  const many = sourceProfiles.length > 1;
  return (
    <>
      <Title
        title="Unlock your data for import"
        turn={runStepLabel(flow)}
        subtitle={`${APP} can securely import logins, cookies and cards from your previous browser, so you stay signed in and don't have to enter your passwords again.`}
      />
      <Handoff
        iconPath={source.iconPath}
        symbol="lock.fill"
        lead={
          many
            ? `Some data is encrypted, so macOS will ask for your computer password once for each selected profile.`
            : `Some data is encrypted, so macOS will ask for your computer password to bring it securely into ${APP}.`
        }
        detail={`macOS may ask whether ${APP} can use “${source.keychainService ?? `${source.name} Safe Storage`}” from your keychain: it's the key ${source.name} encrypts passwords, cookies, cards and open tabs with. Click Allow. Your data stays on this Mac.`}
      />
      {error && <ErrorText text={error} />}
    </>
  );
}

export function UnlockFooter({ flow }: { flow: ImportFlow }) {
  const { source, step } = flow;
  if (!source || step.name !== "unlock") return null;
  const { unlocking } = step;
  const back = source.profiles.length > 1 || importsBySpaces(source) ? "profiles" : "choose";
  return (
    <>
      {(back === "profiles" || canGoBackToChoose(flow)) && <Button title="Back" onPress={() => backTo(back, flow.turn)} />}
      <Spacer />
      <Button title="Skip Encrypted Data" onPress={() => skipEncryptedData(flow.turn)} />
      <Button title={unlocking ? "Waiting for password..." : "Continue"} kind="primary" disabled={unlocking} onPress={() => void unlockAndImport(flow.turn)} />
    </>
  );
}
