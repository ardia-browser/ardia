import { useState } from "react";
import { TextInput, View } from "react-native";
import { Button, Text } from "../ui";
import { goToStep } from "../../state/onboarding/onboarding";
import { applySetupCodeInOnboarding } from "../../state/presets/actions";
import { SETUP_CODE_PREFIX } from "../../state/presets/setupCode";
import { StepLayout } from "./StepLayout";
import { BackButton, PrimaryButton, SecondaryButton } from "./Buttons";
import { useOnboardingColors } from "./Parts";
import { onboardingButton } from "./tokens";
import { font, monoFace, proseLineHeight, radius, space } from "../ui/tokens";
import { ChoiceCard } from "./ChoiceCard";
import { SetupLines } from "./SetupLines";
import { keyText } from "../../state/commands/keyText";
import { t } from "../../lib/uiLanguage";


const CODE_FIELD_HEIGHT = 44;

const BRINGS = [t(`Where your tabs and address bar go`), `What ${keyText("⌘T")} and ${keyText("⌘L")} open`, t(`Light or dark, and your color`), t(`The apps you pinned`)];

export function SetupCodeLink({ onPress }: { onPress: () => void }) {
  return (
    <View mouseDownCanMoveWindow={false} style={{ marginLeft: "auto", height: onboardingButton.height, justifyContent: "center" }}>
      <Button variant="text" look="link" tone="textSecondary" label={t(`Have a setup code from ardia.dev?`)} title={t(`Have a setup code?`)} onPress={onPress} />
    </View>
  );
}

export function SetupCodeStep({ onBack }: { onBack: () => void }) {
  const colors = useOnboardingColors();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string[] | null>(null);

  const apply = () => {
    const result = applySetupCodeInOnboarding(code);
    if (result.ok) setApplied(result.lines);
    else setError(result.error);
  };

  if (applied)
    return (
      <StepLayout
        pageKey="setupCodeApplied"
        title={t(`You're set up`)}
        subtitle={t(`Ardia now looks the way you made it on ardia.dev. Search and privacy are still yours to choose, so those come next.`)}
        actions={
          <>
            <PrimaryButton title={t(`Continue`)} icon="arrow.right" onPress={() => goToStep("searchPrivacy")} />
            <SecondaryButton title={t(`Review Each Step`)} onPress={() => goToStep("layout")} />
          </>
        }
        preview={<SetupLines heading={t(`From your code:`)} lines={applied} />}
      />
    );

  return (
    <StepLayout
      pageKey="setupCode"
      title={t(`Have a setup code from ardia.dev?`)}
      subtitle={t(`Paste the code from the demo. It brings the layout, look and pinned apps you picked there.`)}
      actions={
        <>
          <BackButton onPress={onBack} />
          <PrimaryButton title={t(`Apply Code`)} disabled={!code.trim()} onPress={apply} />
        </>
      }
      preview={<SetupLines heading={t(`A code brings over:`)} lines={BRINGS} />}
    >
      <ChoiceCard plain selected={!!error} fill={colors.row} radius={radius.panel} style={{ height: CODE_FIELD_HEIGHT, paddingHorizontal: space.xl, justifyContent: "center" }}>
        <TextInput
          value={code}
          onChangeText={(text) => {
            setCode(text);
            setError(null);
          }}
          onSubmitEditing={() => code.trim() && apply()}
          placeholder={`${SETUP_CODE_PREFIX}…`}
          placeholderTextColor={colors.steps}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          enableFocusRing={false}
          accessibilityLabel={t(`Setup code`)}
          style={{ ...font.body, ...monoFace(), color: colors.title, paddingVertical: 0 }}
        />
      </ChoiceCard>
      <Text size="small" color={error ? colors.title : colors.rowSubtitle} style={{ lineHeight: proseLineHeight.small }}>
        {error ?? t(`Search, privacy and default browser stay yours to pick here.`)}
      </Text>
    </StepLayout>
  );
}
