import { View } from "react-native";
import { useOnboarding } from "../../state/onboarding/onboarding";
import { Intro } from "./Intro";
import { closeIntroWindowFor, handOffFromIntro } from "./introCover";

export function IntroWindow() {
  const session = useOnboarding((s) => s.session);
  return (
    <View style={{ flex: 1 }}>
      <Intro key={session} overlay onExitStart={(burst) => handOffFromIntro(burst, session)} onDone={() => closeIntroWindowFor(session)} />
    </View>
  );
}
