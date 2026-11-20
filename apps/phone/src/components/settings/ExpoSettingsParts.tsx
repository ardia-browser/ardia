import type { ReactNode } from "react";
import { Section, Text, VStack } from "@expo/ui/swift-ui";
import { listRowBackground, listRowInsets } from "@expo/ui/swift-ui/modifiers";
import { SettingsHeroContent, settingsUIAvailable, SetupStepRow, type SettingsTintName, type SetupProgress } from "../ui";

const PAGE_INSET = 16;

type HeroProps = { title: string; subtitle: string; warning?: boolean; systemImage: string; tint: SettingsTintName; children?: ReactNode };

export function ExpoHero({ title, subtitle, warning = false, systemImage, tint, children }: HeroProps) {
  return (
    <Section modifiers={[listRowBackground("clear"), listRowInsets({ top: 0, leading: PAGE_INSET, bottom: 0, trailing: PAGE_INSET })]}>
      {settingsUIAvailable() ? (
        <SettingsHeroContent title={title} subtitle={subtitle} subtitleIsWarning={warning} systemImage={systemImage} tint={tint}>
          {children}
        </SettingsHeroContent>
      ) : (
        <VStack spacing={12}>
          <Text>{title}</Text>
          <Text>{subtitle}</Text>
          {children}
        </VStack>
      )}
    </Section>
  );
}

type StepProps = { number: number; title: string; detail: string; progress: SetupProgress; children?: ReactNode };

export function ExpoStep({ number, title, detail, progress, children }: StepProps) {
  if (settingsUIAvailable()) {
    return (
      <SetupStepRow number={number} title={title} detail={detail} progress={progress}>
        {children}
      </SetupStepRow>
    );
  }
  return (
    <VStack alignment="leading" spacing={4}>
      <Text>{title}</Text>
      <Text>{detail}</Text>
      {children}
    </VStack>
  );
}
