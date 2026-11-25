import { t } from "../../../lib/i18n";
import { Button } from "../../ui";
import { APP } from "../model";
import { ErrorText, Handoff, Spacer, Title } from "../Parts";
import { backTo, importsBySpaces, type ImportFlow } from "../../../state/import/flow";
import { skipEncryptedData, unlockAndImport } from "../../../state/import/runImport";

export function UnlockBody({ flow }: { flow: ImportFlow }) {
  const { source, sourceProfiles, step } = flow;
  if (!source || step.name !== "unlock") return null;
  const { error } = step;
  const many = sourceProfiles.length > 1;
  return (
    <>
      <Title
        title={t("Unlock your data for import")}
        subtitle={t("{app} can securely import logins, cookies and cards from your previous browser, so you stay signed in and don't have to enter your passwords again.", { app: APP })}
      />
      <Handoff
        iconPath={source.iconPath}
        symbol="lock.fill"
        lead={
          many
            ? `Some data is encrypted, so macOS will ask for your computer password once for each selected profile.`
            : t("Some data is encrypted, so macOS will ask for your computer password to bring it securely into {app}.", { app: APP })
        }
        detail={t("macOS may ask whether {app} can use “{service}” from your keychain: it's the key {source} encrypts passwords, cookies, cards and open tabs with. Click Allow. Your data stays on this Mac.", { app: APP, source: source.name, service: source.keychainService ?? `${source.name} Safe Storage` })}
      />
      {error && <ErrorText text={error} />}
    </>
  );
}

export function UnlockFooter({ flow }: { flow: ImportFlow }) {
  const { source, step } = flow;
  if (!source || step.name !== "unlock") return null;
  const { unlocking } = step;
  return (
    <>
      <Button title={t("Back")} onPress={() => backTo(source.profiles.length > 1 || importsBySpaces(source) ? "profiles" : "choose")} />
      <Spacer />
      <Button title={t("Skip Encrypted Data")} onPress={skipEncryptedData} />
      <Button title={unlocking ? t("Waiting for password...") : "Continue"} kind="primary" disabled={unlocking} onPress={() => void unlockAndImport()} />
    </>
  );
}
