import { View } from "react-native";
import { Button } from "../ui";
import { useWindowId } from "../../state/browser/hooks";
import { onboardingTestRun, resetOnboarding } from "../../state/onboarding/devTools";
import { t } from "../../lib/uiLanguage";


export function DevResetOnboarding() {
  const windowId = useWindowId();
  if (!onboardingTestRun()) return null;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", right: 14, top: 12 }}>
      <Button variant="push" kind="destructive" title={t(`Reset onboarding`)} onPress={() => resetOnboarding(windowId)} />
    </View>
  );
}
