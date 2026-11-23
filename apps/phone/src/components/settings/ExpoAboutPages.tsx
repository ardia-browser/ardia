import { PlatformColor } from "react-native";
import { Button, Form, HStack, Image, LabeledContent, NavigationLink, Section, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityHidden, accessibilityHint, font, foregroundStyle, frame, lineLimit, listRowBackground, navigationBarTitleDisplayMode, navigationTitle, opacity, padding, shadow, textSelection, tint, truncationMode } from "@expo/ui/swift-ui/modifiers";
import { copy } from "../../lib/platformCopy";
import { appVersion, openFromSettings } from "../../state/settings/actions";
import { settingsRouteKey } from "../../state/settings/nav";
import { AppIconPreview, modifierList, settingsChrome, settingsUIAvailable, useTheme } from "../ui";
import { dataCredits, LIBRARY_CREDITS } from "./DataPages";

const FILL = Number.MAX_SAFE_INTEGER;
const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const BLUE = PlatformColor("systemBlue");
const LINKS = [
  { title: "ardia.dev", url: "https://ardia.dev" },
  { title: "Release Notes", url: "https://ardia.dev/release-notes" },
  { title: "Source Code", url: "https://github.com/ardia-browser/ardia" },
] as const;

const page = (title: string) => modifierList(navigationTitle(title), navigationBarTitleDisplayMode("inline"), tint(BLUE), settingsChrome());

export function ExpoAboutPage() {
  const theme = useTheme();
  return (
    <Form modifiers={page("About Ardia")}>
      <Section>
        <VStack spacing={12} modifiers={[frame({ maxWidth: FILL }), listRowBackground("clear")]}>
          {settingsUIAvailable() ? <AppIconPreview side={72} modifiers={[shadow({ radius: 10, y: 4, color: "rgba(0,0,0,0.12)" })]} /> : null}
          <VStack spacing={4}>
            <Text modifiers={[font({ textStyle: "title", weight: "bold" }), accessibilityAddTraits(["isHeader"])]}>Ardia</Text>
            <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(SECONDARY), textSelection(true)]}>{appVersion()}</Text>
          </VStack>
        </VStack>
      </Section>
      <Section footer={<Text>{copy().privacy}</Text>}>
        {LINKS.map((link) => (
          <Button key={link.url} onPress={() => openFromSettings(link.url)} modifiers={[accessibilityHint("Opens in a new tab")]}>
            <HStack>
              <Text modifiers={[foregroundStyle(theme.formAccent)]}>{link.title}</Text>
              <Spacer />
              <Image systemName="arrow.up.forward" modifiers={[font({ textStyle: "footnote", weight: "semibold" }), foregroundStyle(theme.formAccent), opacity(0.35), accessibilityHidden(true)]} />
            </HStack>
          </Button>
        ))}
      </Section>
      <Section>
        <NavigationLink value={settingsRouteKey({ page: "licenses" })}>
          <Text>Open Source Licenses</Text>
        </NavigationLink>
      </Section>
    </Form>
  );
}

export function ExpoLicensesPage() {
  return (
    <Form modifiers={page("Open Source Licenses")}>
      {dataCredits().map((credit) => (
        <Section key={credit.name}>
          <VStack alignment="leading" spacing={4} modifiers={[padding({ vertical: 2 }), frame({ maxWidth: FILL, alignment: "leading" })]}>
            <Text modifiers={[font({ textStyle: "body", weight: "semibold" })]}>{credit.name}</Text>
            <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(SECONDARY)]}>{credit.use}</Text>
          </VStack>
          <LabeledContent label="License">
            <Text>{credit.license}</Text>
          </LabeledContent>
          <Button onPress={() => openFromSettings(credit.url)} modifiers={[accessibilityHint("Opens in a new tab")]}>
            <Text modifiers={[lineLimit(1), truncationMode("middle")]}>{credit.url.replace(/^https:\/\//, "")}</Text>
          </Button>
        </Section>
      ))}
      <Section title="Code in This App">
        {LIBRARY_CREDITS.map((credit) => (
          <Button key={`${credit.name}@${credit.detail}`} onPress={() => openFromSettings(credit.url)} modifiers={[tint("primary"), accessibilityHint("Opens in a new tab")]}>
            <HStack spacing={12}>
              <VStack alignment="leading" spacing={2} modifiers={[frame({ maxWidth: FILL, alignment: "leading" })]}>
                <Text modifiers={[lineLimit(1)]}>{credit.name}</Text>
                <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(SECONDARY), lineLimit(2)]}>{credit.detail}</Text>
              </VStack>
              <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(SECONDARY)]}>{credit.license}</Text>
            </HStack>
          </Button>
        ))}
      </Section>
    </Form>
  );
}
