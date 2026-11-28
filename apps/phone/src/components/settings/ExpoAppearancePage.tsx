import { useMemo } from "react";
import { PlatformColor } from "react-native";
import { themeAccent, themePalette } from "@ardia/core/src/theme.ts";
import { Button, Form, HStack, NavigationLink, Section, Text, Toggle, VStack } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityLabel, buttonStyle, frame, navigationBarTitleDisplayMode, navigationTitle, padding, tint } from "@expo/ui/swift-ui/modifiers";
import { actionWords } from "../../lib/sharedWords";
import { rainbow } from "../../lib/themeEditor";
import { INTERFACE_STYLE_NAMES, INTERFACE_STYLES, offeredInterfaceStyle, offeredScheme, SCHEME_CHOICES, SCHEME_NAMES } from "../../lib/appearance";
import { setColorChoice, setInterfaceStyle, setSchemeChoice } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { chooseCustomTheme, resetPresetTheme } from "../../state/settings/customTheme";
import { selectedSwatch } from "../../state/settings/themeDraft";
import { settingsRouteKey } from "../../state/settings/nav";
import { CUSTOM_CHOICE } from "../../lib/profileLook";
import type { PresetColor } from "../../state/settings/preferences";
import { matchMyMac } from "../../state/sync/actions";
import { useSyncEnabled } from "../../state/sync/hooks";
import { syncOffered } from "../../state/sync/offer";
import { ColorSwatch, contentMargins, controlSize, modifierList, PROFILE_COLORS, neverBounces, settingsChrome, settingsLayout, settingsSwitchStyle, settingsTint, settingsUIAvailable, themeEditorLayout, useProfileLook, type ProfileColor } from "../ui";
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
  const edited = usePreferences((p) => (p.colorChoice && p.colorChoice !== CUSTOM_CHOICE ? Boolean(p.presetThemes[p.colorChoice]) : false));
  const look = useProfileLook();
  const picked = usePreferences((p) => selectedSwatch(p, look));
  return (
    <Form modifiers={modifierList(navigationTitle("Appearance"), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), neverBounces(), contentMargins({ edges: "top", length: settingsLayout.expoListTop }))}>
      <Section>
        <VStack alignment="leading" spacing={12} modifiers={[padding({ vertical: 4 })]}>
          <Text>{actionWords.color}</Text>
          <HStack spacing={0}>
            {COLORS.slice(0, ROW_LENGTH).map((color) => (
              <Swatch key={color} color={color} selected={color === picked} />
            ))}
          </HStack>
          <HStack spacing={0}>
            {COLORS.slice(ROW_LENGTH).map((color) => (
              <Swatch key={color} color={color} selected={color === picked} />
            ))}
            <CustomSwatch selected={picked === "custom"} />
          </HStack>
        </VStack>
        <NavigationLink value={settingsRouteKey({ page: "theme" })}>
          <Text>Edit theme</Text>
        </NavigationLink>
        {edited && chosen && chosen !== CUSTOM_CHOICE ? <Button label={resetLabel(chosen)} onPress={() => resetPresetTheme(chosen)} /> : null}
        {syncEnabled ? (
          <Toggle isOn={chosen === null} onIsOnChange={(on) => matchMyMac(on, look)} modifiers={modifierList(settingsSwitchStyle())}>
            <Text>Match My Mac</Text>
          </Toggle>
        ) : null}
      </Section>
      <Section title="Interface style" footer={offersSync ? <Text>Match My Mac follows your Mac. Reduce Transparency in iOS Settings always uses Classic.</Text> : undefined}>
        {styleChoices.map((choice) => (
          <ExpoChoiceRow key={choice} title={INTERFACE_STYLE_NAMES[choice]} checked={style === choice} onPress={() => setInterfaceStyle(choice)} />
        ))}
      </Section>
      <Section title="Light or dark" footer={<Text>{offersSync ? "Match My Mac follows your Mac. System follows this device." : "System follows this device."}</Text>}>
        {schemeChoices.map((choice) => (
          <ExpoChoiceRow key={choice} title={SCHEME_NAMES[choice]} checked={scheme === choice} onPress={() => setSchemeChoice(choice)} />
        ))}
      </Section>
    </Form>
  );
}

export const presetName = (color: PresetColor, edited: boolean) => (edited ? `${PROFILE_COLORS[color].name}, edited` : PROFILE_COLORS[color].name);

const resetLabel = (color: PresetColor) => `Reset to ${PROFILE_COLORS[color].name}`;

function Swatch({ color, selected }: { color: PresetColor; selected: boolean }) {
  const edits = usePreferences((p) => p.presetThemes[color] ?? null);
  const colors = useMemo(() => (edits ? [...themePalette(edits)] : null), [edits]);
  const name = presetName(color, edits !== null);
  return (
    <Button onPress={() => setColorChoice(color)} modifiers={[buttonStyle("plain"), frame({ maxWidth: FILL, minHeight: SWATCH_HIT }), accessibilityLabel(name), accessibilityAddTraits(selected ? ["isButton", "isSelected"] : ["isButton"])]}>
      {settingsUIAvailable() ? colors && edits ? <ColorSwatch preset={color} colors={colors} ring={themeAccent(edits)} isSelected={selected} /> : <ColorSwatch preset={color} isSelected={selected} /> : <Text>{name}</Text>}
    </Button>
  );
}

function CustomSwatch({ selected }: { selected: boolean }) {
  const look = useProfileLook();
  const saved = usePreferences((p) => p.customTheme);
  const colors = useMemo(() => (saved ? themePalette(saved) : RAINBOW), [saved]);
  const ring = saved ? themeAccent(saved) : settingsTint.neutral;
  return (
    <Button onPress={() => chooseCustomTheme(look)} modifiers={[buttonStyle("plain"), frame({ maxWidth: FILL, minHeight: SWATCH_HIT }), accessibilityLabel(CUSTOM_SWATCH_LABEL), accessibilityAddTraits(selected ? ["isButton", "isSelected"] : ["isButton"])]}>
      {settingsUIAvailable() ? <ColorSwatch preset="plum" colors={[...colors]} ring={ring} isSelected={selected} /> : <Text>{CUSTOM_SWATCH_LABEL}</Text>}
    </Button>
  );
}
