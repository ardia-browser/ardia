import { useEffect } from "react";
import { AppState, PlatformColor } from "react-native";
import { Button, Divider, Form, HStack, Image, ScrollView, Section, Text, VStack } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityElement, background, buttonBorderShape, buttonStyle, clipShape, fixedSize, font, foregroundStyle, frame, multilineTextAlignment, navigationBarTitleDisplayMode, navigationTitle, padding, tint } from "@expo/ui/swift-ui/modifiers";
import { PHONE_SHARING_COPY, PHONE_WHATS_SENT } from "../../lib/telemetryCopy";
import { askForDefaultBrowser, refreshDefaultBrowser, useDefaultBrowser } from "../../state/settings/defaultBrowser";
import { defaultBrowserCopy } from "../../state/settings/settingsRules";
import { AppIconPreview, modifierList, settingsChrome, SettingsIconTile, settingsUIAvailable, useTheme } from "../ui";
import { t } from "../../lib/uiLanguage";


const FILL = Number.MAX_SAFE_INTEGER;
const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const BLUE = PlatformColor("systemBlue");

export function ExpoDefaultBrowserPage() {
  const theme = useTheme();
  const status = useDefaultBrowser((s) => s.status);
  useEffect(() => {
    void refreshDefaultBrowser();
    const returns = AppState.addEventListener("change", (next) => {
      if (next === "active") void refreshDefaultBrowser();
    });
    return () => returns.remove();
  }, []);
  const copy = status ? defaultBrowserCopy(status) : null;
  return (
    <ScrollView modifiers={modifierList(navigationTitle(t(`Default Browser`)), navigationBarTitleDisplayMode("inline"), tint(BLUE), settingsChrome())}>
      {copy ? (
        <VStack spacing={24} modifiers={[padding({ horizontal: 20, top: 24, bottom: 32 })]}>
          <VStack spacing={12}>
            <Text modifiers={[font({ textStyle: "title", design: "rounded", weight: "bold" }), multilineTextAlignment("center"), fixedSize({ horizontal: false, vertical: true }), accessibilityAddTraits(["isHeader"])]}>{copy.title}</Text>
            <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(SECONDARY), multilineTextAlignment("center"), fixedSize({ horizontal: false, vertical: true })]}>{copy.subtitle}</Text>
          </VStack>
          {copy.steps.length ? (
            <VStack spacing={0} modifiers={[background(PlatformColor("secondarySystemGroupedBackground")), clipShape("roundedRectangle", 16)]}>
              {copy.steps.map((step, index) => (
                <VStack key={step} spacing={0}>
                  {index > 0 ? <Divider modifiers={[padding({ leading: 56 })]} /> : null}
                  <HStack spacing={15} modifiers={[frame({ maxWidth: FILL, minHeight: 52, alignment: "leading" }), padding({ horizontal: 16, vertical: 4 }), accessibilityElement("combine")]}>
                    <StepIcon index={index} count={copy.steps.length} inSettings={copy.inSettings} />
                    <Text>{`${index + 1}. ${step}`}</Text>
                  </HStack>
                </VStack>
              ))}
            </VStack>
          ) : null}
          {copy.action ? (
            <Button
              onPress={() => void askForDefaultBrowser(copy.does)}
              modifiers={[buttonStyle("borderedProminent"), buttonBorderShape("roundedRectangle", 14), tint(theme.primaryAction), foregroundStyle(theme.onPrimaryAction)]}
            >
              <Text modifiers={[font({ textStyle: "body", weight: "semibold" }), frame({ maxWidth: FILL, minHeight: 50 })]}>{copy.action}</Text>
            </Button>
          ) : null}
        </VStack>
      ) : null}
    </ScrollView>
  );
}

function StepIcon({ index, count, inSettings }: { index: number; count: number; inSettings: boolean }) {
  if (index === count - 1) return settingsUIAvailable() ? <AppIconPreview side={29} /> : null;
  if (inSettings && index === 0) return settingsUIAvailable() ? <SettingsIconTile systemImage="gear" tint="neutral" baseSide={29} /> : null;
  return <Image systemName="hand.point.up.left.fill" modifiers={[font({ size: 18 }), foregroundStyle(SECONDARY), frame({ width: 29, height: 29 })]} />;
}

export function ExpoWhatsSentPage() {
  return (
    <Form modifiers={modifierList(navigationTitle(PHONE_SHARING_COPY.whatsSent), navigationBarTitleDisplayMode("inline"), tint(BLUE), settingsChrome())}>
      {PHONE_WHATS_SENT.map((section, index) => (
        <Section key={section.title} title={section.title} footer={index === PHONE_WHATS_SENT.length - 1 ? <Text>{PHONE_SHARING_COPY.footnote}</Text> : undefined}>
          {section.items.map((item) => (
            <Text key={item.text} modifiers={[font({ textStyle: "subheadline" })]}>
              {item.text}
            </Text>
          ))}
        </Section>
      ))}
    </Form>
  );
}
