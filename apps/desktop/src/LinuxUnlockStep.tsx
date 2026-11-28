import { useEffect, useSyncExternalStore } from "react";
import { View } from "react-native";
import { Button, TextField } from "../../browser/src/components/ui";
import { ErrorText, Handoff, Spacer, Title } from "../../browser/src/components/import/Parts";
import { backTo, canGoBackToChoose, importNow, importsBySpaces, patchImport, runStepLabel, type ImportFlow } from "../../browser/src/state/import/flow";
import { importModule } from "../../browser/src/state/import/importApi";
import { importUnlocked } from "../../browser/src/state/import/runImport";
import { asksPrimaryPassword, createSecretSlot, unlockCopy, unlockForStep, unlockSource, withoutEncrypted } from "./importUnlock";

const primaryPassword = createSecretSlot();

function useTypedSecret() {
  return useSyncExternalStore(primaryPassword.subscribe, primaryPassword.get);
}

const unlockStep = (unlocking: boolean, error: string | null) => patchImport({ step: { name: "unlock", unlocking, error } });

async function unlock(token: number | null) {
  const { source, sourceProfiles, kinds, step, turn } = importNow();
  if (!source || step.name !== "unlock" || step.unlocking || turn !== token) return;
  if (asksPrimaryPassword(source, sourceProfiles) && !primaryPassword.get()) return;
  unlockStep(true, null);
  const settled = await unlockForStep(importNow, () => unlockSource(importModule(), source, sourceProfiles, kinds, primaryPassword));
  if (!settled || importNow().turn !== token) return;
  unlockStep(false, settled.result);
  if (!settled.result) void importUnlocked(token, importNow().kinds, false);
}

function skipEncrypted(source: NonNullable<ImportFlow["source"]>, token: number | null) {
  const { step, turn, kinds } = importNow();
  if (step.name !== "unlock" || turn !== token) return;
  primaryPassword.clear();
  const without = withoutEncrypted(source, kinds);
  patchImport({ kinds: without });
  void importUnlocked(token, without, true);
}

export function UnlockBody({ flow }: { flow: ImportFlow }) {
  const { source, sourceProfiles, kinds, step } = flow;
  const typed = useTypedSecret();
  useEffect(() => () => primaryPassword.clear(), []);
  if (!source || step.name !== "unlock") return null;
  const { error } = step;
  const copy = unlockCopy(source, sourceProfiles, kinds);
  return (
    <>
      <Title title={copy.title} subtitle={copy.subtitle} turn={runStepLabel(flow)} />
      <Handoff iconPath={source.iconPath} symbol="lock.fill" lead={copy.lead} detail={copy.detail} />
      {copy.field && (
        <View style={{ alignSelf: "center", width: 260, marginTop: 16 }}>
          <TextField
            value={typed}
            onChangeText={primaryPassword.set}
            placeholder="Primary password"
            secure
            autoFocus
            onSubmit={() => void unlock(flow.turn)}
          />
        </View>
      )}
      {error && <ErrorText text={error} />}
    </>
  );
}

export function UnlockFooter({ flow }: { flow: ImportFlow }) {
  const { source, kinds, sourceProfiles, step } = flow;
  const typed = useTypedSecret();
  if (!source || step.name !== "unlock") return null;
  const { unlocking } = step;
  const copy = unlockCopy(source, sourceProfiles, kinds);
  const back = source.profiles.length > 1 || importsBySpaces(source) ? "profiles" : "choose";
  return (
    <>
      {(back === "profiles" || canGoBackToChoose(flow)) && <Button title="Back" onPress={() => backTo(back, flow.turn)} />}
      <Spacer />
      <Button title="Skip Encrypted Data" onPress={() => skipEncrypted(source, flow.turn)} />
      <Button
        title={unlocking ? copy.waiting : "Continue"}
        kind="primary"
        disabled={unlocking || (copy.field && !typed)}
        onPress={() => void unlock(flow.turn)}
      />
    </>
  );
}
