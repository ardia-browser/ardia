import { useLayoutEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { activeSteps, previousStep, useOnboarding } from "../../state/onboarding/onboarding";
import { BackButton, PrimaryButton, SecondaryButton } from "./Buttons";
import { StepTitle, Tag } from "./Parts";
import { space } from "../ui/tokens";
import { useFlowSlots, useSection } from "./sectionContext";

export function StepLayout({
  title,
  subtitle,
  tag,
  pageKey,
  children,
  actions,
  preview,
}: {
  title: string;
  subtitle?: string;
  tag?: string;
  pageKey?: string | number;
  children?: ReactNode;
  actions: ReactNode;
  preview?: ReactNode;
}) {
  const section = useSection();
  const slots = useFlowSlots();
  const layer = pageKey === undefined || pageKey === section.id ? section.key : `${section.key}:${pageKey}`;
  useLayoutEffect(() => {
    if (section.active) slots.publish({ key: layer, actions, preview: preview ?? null });
  });
  return (
    <View style={{ gap: space.xxxl }}>
      <View style={{ gap: space.ml }}>
        <StepTitle title={title} subtitle={subtitle} />
        {tag ? (
          <View style={{ flexDirection: "row" }}>
            <Tag title={tag} />
          </View>
        ) : null}
      </View>
      {children ? <View style={{ gap: space.xl }}>{children}</View> : null}
    </View>
  );
}

export function FittedPreview({ children }: { children: ReactNode }) {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [content, setContent] = useState<{ width: number; height: number } | null>(null);
  const scale = box && content && content.width && content.height ? Math.min(1, box.width / content.width, box.height / content.height) : 1;
  return (
    <View style={{ flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center" }} onLayout={(e) => setBox(e.nativeEvent.layout)}>
      <View style={{ alignItems: "center", justifyContent: "center", transform: [{ scale }] }} onLayout={(e) => setContent(e.nativeEvent.layout)}>
        {children}
      </View>
    </View>
  );
}

export function StepActions({
  onContinue,
  continueTitle = "Continue",
  disabled,
  onSkip,
  icon,
  holdScroll,
  holdForward,
}: {
  onContinue: () => void;
  continueTitle?: string;
  disabled?: boolean;
  onSkip?: () => void;
  icon?: string;
  holdScroll?: boolean;
  holdForward?: boolean;
}) {
  const step = useOnboarding((s) => s.step);
  const sub = useOnboarding((s) => s.sub);
  const slots = useFlowSlots();
  const steps = activeSteps();
  const first = steps[steps.indexOf(step) - 1] === "intro" && sub === 0;
  useLayoutEffect(() => {
    slots.forward.run = disabled || holdForward ? null : holdScroll ? (onSkip ?? null) : onContinue;
  });
  return (
    <>
      {first ? null : <BackButton onPress={previousStep} />}
      <PrimaryButton title={continueTitle} icon={icon} onPress={onContinue} disabled={disabled} />
      {onSkip ? <SecondaryButton title="Skip" onPress={onSkip} /> : null}
    </>
  );
}
