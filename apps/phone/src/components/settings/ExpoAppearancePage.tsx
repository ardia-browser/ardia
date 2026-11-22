import { useMemo } from "react";
import { PlatformColor, StyleSheet, View } from "react-native";
import { themeAccent, themePalette } from "@ardia/core/src/theme.ts";
import { Button, Form, HStack, NavigationLink, RNHostView, Section, Text, Toggle, VStack } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityLabel, buttonStyle, frame, navigationBarTitleDisplayMode, navigationTitle, padding, tint } from "@expo/ui/swift-ui/modifiers";
import { linearGradientCss } from "../../lib/gradient";
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
import { capsule, CheckmarkLabel, ColorSwatch, ink, contentMargins, modifierList, PROFILE_COLORS, settingsChrome, settingsLayout, settingsSwitchStyle, settingsTint, settingsUIAvailable, themeEditorLayout, useProfileLook, type ProfileColor } from "../ui";

const COLORS = Object.keys(PROFILE_COLORS) as ProfileColor[];
const FILL = Number.MAX_SAFE_INTEGER;
const SWATCH_HIT = 44;
const ROW_LENGTH = 5;
const RAINBOW = rainbow(themeEditorLayout.rainbowStops);
const RING = settingsLayout.swatch + (settingsLayout.swatchGap + settingsLayout.swatchRing) * 2;

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
          <Text>Color</Text>
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
          <Choice key={choice} title={INTERFACE_STYLE_NAMES[choice]} checked={style === choice} onPress={() => setInterfaceStyle(choice)} />
        ))}
      </Section>
      <Section title="Light or Dark" footer={<Text>{offersSync ? "Match My Mac follows your Mac. System follows this device." : "System follows this device."}</Text>}>
        {schemeChoices.map((choice) => (
          <Choice key={choice} title={SCHEME_NAMES[choice]} checked={scheme === choice} onPress={() => setSchemeChoice(choice)} />
        ))}
      </Section>
      <Section title="Tabs" footer={<Text>{TABS_STYLE_FOOTER}</Text>}>
        <Choice title="Stack" checked={!grid} onPress={() => setDeckGrid(false, !incognito)} />
        <Choice title="Grid" checked={grid} onPress={() => setDeckGrid(true, !incognito)} />
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
    <Button onPress={() => openThemeEditor(look)} modifiers={[buttonStyle("plain"), frame({ maxWidth: FILL, minHeight: SWATCH_HIT }), accessibilityLabel("Custom"), accessibilityAddTraits(selected ? ["isButton", "isSelected"] : ["isButton"])]}>
      <RNHostView matchContents>
        <View pointerEvents="none" style={styles.ringBox}>
          <View style={[StyleSheet.absoluteFill, styles.ring, { borderColor: selected ? ring : ink.clear }]} />
          <View style={[styles.swatch, { experimental_backgroundImage: linearGradientCss(colors, true, settingsLayout.swatch, settingsLayout.swatch) }]} />
        </View>
      </RNHostView>
    </Button>
  );
}

function Choice({ title, checked, onPress }: { title: string; checked: boolean; onPress: () => void }) {
  return (
    <Button onPress={onPress} modifiers={[tint("primary"), accessibilityAddTraits(checked ? ["isSelected"] : [])]}>
      {settingsUIAvailable() ? <CheckmarkLabel title={title} isChecked={checked} /> : <Text>{checked ? `${title} ✓` : title}</Text>}
    </Button>
  );
}

const styles = StyleSheet.create({
  ringBox: { width: RING, height: RING, alignItems: "center", justifyContent: "center" },
  ring: { borderRadius: capsule(RING), borderWidth: settingsLayout.swatchRing },
  swatch: { width: settingsLayout.swatch, height: settingsLayout.swatch, borderRadius: capsule(settingsLayout.swatch) },
});
