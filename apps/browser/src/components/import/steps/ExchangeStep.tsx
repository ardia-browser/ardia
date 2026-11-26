import { View } from "react-native";
import { Button, space, Text } from "../../ui";
import { APP } from "../model";
import { ErrorText, Spacer, StepBadge, TargetPicker, Title } from "../Parts";
import { importType } from "../tokens";
import { backToSources, closeImport, setImportTarget, type ImportFlow } from "../../../state/import/flow";
import { askPasswordManager } from "../../../state/import/credentialExchange";

const STEPS = ["Open Passwords, or the password manager that keeps your logins.", `Export your passwords to another app and choose ${APP}.`, `${APP} saves them and shows what came over.`];

export function ExchangeBody({ flow }: { flow: ImportFlow }) {
  const { step } = flow;
  if (step.name !== "exchange") return null;
  if (step.phase === "importing")
    return <Title title={step.exporter ? `Importing from ${step.exporter}` : "Importing your passwords"} subtitle="Saving passwords and verification codes…" spinner />;
  return (
    <>
      <Title title="Import from a Password Manager" subtitle={`Passwords and their verification codes come straight from the app that keeps them, with no file to save or delete.`} />
      <View style={{ gap: space.ml }}>
        {STEPS.map((text, i) => (
          <View key={text} style={{ flexDirection: "row", alignItems: "center", gap: space.ml }}>
            <StepBadge>{i + 1}</StepBadge>
            <Text style={{ flex: 1 }}>{text}</Text>
          </View>
        ))}
      </View>
      <Text size="caption" tone="textSecondary" style={{ lineHeight: importType.smallLine, marginTop: space.xl }}>
        {`Passkeys stay in the app they're in: ${APP} can't store imported passkeys yet.`}
      </Text>
      {step.error && <ErrorText text={step.error} />}
    </>
  );
}

export function ExchangeFooter({ flow }: { flow: ImportFlow }) {
  const importing = flow.step.name === "exchange" && flow.step.phase === "importing";
  return (
    <>
      <Button title="Back" disabled={importing} onPress={backToSources} />
      <Spacer />
      <TargetPicker target={flow.target} onChange={setImportTarget} />
      <Button title="Cancel" onPress={closeImport} />
      <Button title="Open Passwords" kind="primary" disabled={importing} onPress={() => void askPasswordManager()} />
    </>
  );
}
