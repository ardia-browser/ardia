import { useMemo } from "react";
import { PlatformColor } from "react-native";
import { themeAccent, themePalette } from "@ardia/core/src/theme.ts";
import { Button, Form, HStack, NavigationLink, Section, Text, Toggle, VStack } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityLabel, buttonStyle, frame, navigationBarTitleDisplayMode, navigationTitle, padding, tint } from "@expo/ui/swift-ui/modifiers";
import { actionWords } from "../../lib/sharedWords";
import { rainbow } from "../../lib/themeEditor";
import { INTERFACE_STYLE_NAMES, INTERFACE_STYLES, offeredInterfaceStyle, offeredScheme, SCHEME_CHOICES, SCHEME_NAMES, TABS_STYLE_FOOTER } from "../../lib/appearance";
import { setColorChoice, setInterfaceStyle, setSchemeChoice } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { openThemeEditor } from "../../state/settings/customTheme";
import { settingsRouteKey } from "../../state/settings/nav";
import { matchMyMac } from "../../state/sync/actions";
import { useSyncEnabled } from "../../state/sync/hooks";
import { syncOffered } from "../../state/sync/offer";
import { setDeckGrid, useDeckGrid } from "../../state/browse/deckGrid";
import { useIncognito } from "../../state/tabs/hooks";
import { ColorSwatch, contentMargins, controlSize, modifierList, PROFILE_COLORS, settingsChrome, settingsLayout, settingsSwitchStyle, settingsTint, settingsUIAvailable, themeEditorLayout, useProfileLook, type ProfileColor } from "../ui";
import { ExpoChoiceRow } from "./ExpoSettingsParts";

const COLORS = Object.keys(PROFILE_COLORS) as ProfileColor[];
const FILL = Number.MAX_SAFE_INTEGER;
const SWATCH_HIT = controlSize.hitTarget;
const ROW_LENGTH = 5;
const RAINBOW = rainbow(themeEditorLayout.rainbowStops);
export const CUSTOM_SWATCH_LABEL = "Custom";

export function ExpoAppearancePage() {
  const syncEnabled = useSyncEnabled();
  const offersSync = syncOffered();
  const style = offeredInterfaceStyle(usePreferences((p) => p.interfaceStyle), offersSync);
  const scheme = offeredScheme(usePreferences((p) => p.schemeChoice), offersSync);
  const styleChoices = offersSync ? INTERFACE_STYLES : INTERFACE_STYLES.filter((choice) => choice !== "matchMac");
  const schemeChoices = offersSync ? SCHEME_CHOICES : SCHEME_CHOICES.filter((choice) => choice !== "matchMac");
  const chosen = usePreferences((p) => p.colorChoice);
  const look = useProfileLook();
  const grid = useDeckGrid();
  const incognito = useIncognito();
  return (
    <Form modifiers={modifierList(navigationTitle("Appearance"), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), contentMargins({ edges: "top", length: settingsLayout.expoListTop }))}>
      <Section>
        <VStack alignment="leading" spacing={12} modifiers={[padding({ vertical: 4 })]}>
          <Text>{actionWords.color}</Text>
          <HStack spacing={0}>
            {COLORS.slice(0, ROW_LENGTH).map((color) => (
              <Swatch key={color} color={color} selected={color === look.preset} />
            ))}
          </HStack>
          <HStack spacing={0}>
            {COLORS.slice(ROW_LENGTH).map((color) => (
              <Swatch key={color} color={color} selected={color === look.preset} />
            ))}
            <CustomSwatch selected={chosen === "custom"} />
          </HStack>
        </VStack>
        {chosen === "custom" ? (
          <NavigationLink value={settingsRouteKey({ page: "theme" })}>
            <Text>Edit Theme</Text>
          </NavigationLink>
        ) : null}
        {syncEnabled ? (
          <Toggle isOn={chosen === null} onIsOnChange={(on) => matchMyMac(on, look)} modifiers={modifierList(settingsSwitchStyle())}>
            <Text>Match My Mac</Text>
          </Toggle>
        ) : null}
      </Section>
      <Section title="Interface Style" footer={offersSync ? <Text>Match My Mac follows your Mac. Reduce Transparency in iOS Settings always uses Classic.</Text> : undefined}>
        {styleChoices.map((choice) => (
          <ExpoChoiceRow key={choice} title={INTERFACE_STYLE_NAMES[choice]} checked={style === choice} onPress={() => setInterfaceStyle(choice)} />
        ))}
      </Section>
      <Section title="Light or Dark" footer={<Text>{offersSync ? "Match My Mac follows your Mac. System follows this device." : "System follows this device."}</Text>}>
        {schemeChoices.map((choice) => (
          <ExpoChoiceRow key={choice} title={SCHEME_NAMES[choice]} checked={scheme === choice} onPress={() => setSchemeChoice(choice)} />
        ))}
      </Section>
      <Section title="Tabs" footer={<Text>{TABS_STYLE_FOOTER}</Text>}>
        <ExpoChoiceRow title="Stack" checked={!grid} onPress={() => setDeckGrid(false, !incognito)} />
        <ExpoChoiceRow title="Grid" checked={grid} onPress={() => setDeckGrid(true, !incognito)} />
      </Section>
    </Form>
  );
}

function Swatch({ color, selected }: { color: ProfileColor; selected: boolean }) {
  const name = PROFILE_COLORS[color].name;
  return (
    <Button onPress={() => setColorChoice(color)} modifiers={[buttonStyle("plain"), frame({ maxWidth: FILL, minHeight: SWATCH_HIT }), accessibilityLabel(name), accessibilityAddTraits(selected ? ["isButton", "isSelected"] : ["isButton"])]}>
      {settingsUIAvailable() ? <ColorSwatch preset={color} isSelected={selected} /> : <Text>{name}</Text>}
    </Button>
  );
}

function CustomSwatch({ selected }: { selected: boolean }) {
  const look = useProfileLook();
  const saved = usePreferences((p) => p.customTheme);
  const colors = useMemo(() => (saved ? themePalette(saved) : RAINBOW), [saved]);
  const ring = saved ? themeAccent(saved) : settingsTint.neutral;
  return (
    <Button onPress={() => openThemeEditor(look)} modifiers={[buttonStyle("plain"), frame({ maxWidth: FILL, minHeight: SWATCH_HIT }), accessibilityLabel(CUSTOM_SWATCH_LABEL), accessibilityAddTraits(selected ? ["isButton", "isSelected"] : ["isButton"])]}>
      {settingsUIAvailable() ? <ColorSwatch preset="plum" colors={[...colors]} ring={ring} isSelected={selected} /> : <Text>{CUSTOM_SWATCH_LABEL}</Text>}
    </Button>
  );
}
