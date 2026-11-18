import { PlatformColor } from "react-native";
import { Button, Form, HStack, Section, Text, Toggle, VStack } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityLabel, buttonStyle, frame, navigationBarTitleDisplayMode, navigationTitle, padding, tint } from "@expo/ui/swift-ui/modifiers";
import { INTERFACE_STYLE_NAMES, INTERFACE_STYLES, offeredInterfaceStyle, offeredScheme, SCHEME_CHOICES, SCHEME_NAMES, TABS_STYLE_FOOTER } from "../../lib/appearance";
import { setColorChoice, setInterfaceStyle, setSchemeChoice } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { matchMyMac } from "../../state/sync/actions";
import { useSyncEnabled } from "../../state/sync/hooks";
import { syncOffered } from "../../state/sync/offer";
import { deckGridOffered, setDeckGrid, useDeckGrid } from "../../state/browse/deckGrid";
import { useIncognito } from "../../state/tabs/hooks";
import { CheckmarkLabel, ColorSwatch, contentMargins, modifierList, PROFILE_COLORS, settingsChrome, settingsLayout, settingsSwitchStyle, settingsUIAvailable, useProfileLook, type ProfileColor } from "../ui";

const COLORS = Object.keys(PROFILE_COLORS) as ProfileColor[];
const FILL = Number.MAX_SAFE_INTEGER;
const SWATCH_HIT = 44;

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
            {COLORS.map((color) => (
              <Swatch key={color} color={color} selected={color === look.preset} />
            ))}
          </HStack>
        </VStack>
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
      {deckGridOffered() ? (
        <Section title="Tabs" footer={<Text>{TABS_STYLE_FOOTER}</Text>}>
          <Choice title="Stack" checked={!grid} onPress={() => setDeckGrid(false, !incognito)} />
          <Choice title="Grid" checked={grid} onPress={() => setDeckGrid(true, !incognito)} />
        </Section>
      ) : null}
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

function Choice({ title, checked, onPress }: { title: string; checked: boolean; onPress: () => void }) {
  return (
    <Button onPress={onPress} modifiers={[tint("primary"), accessibilityAddTraits(checked ? ["isSelected"] : [])]}>
      {settingsUIAvailable() ? <CheckmarkLabel title={title} isChecked={checked} /> : <Text>{checked ? `${title} ✓` : title}</Text>}
    </Button>
  );
}
