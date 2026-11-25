import { PlatformColor } from "react-native";
import { Form, HStack, Image, NavigationLink, Section, Text, VStack } from "@expo/ui/swift-ui";
import { accessibilityElement, contentTransition, font, foregroundStyle, listSectionSpacing, navigationBarTitleDisplayMode, navigationTitle, padding, tint } from "@expo/ui/swift-ui/modifiers";
import { useSyncStatus } from "../../state/sync/hooks";
import { syncRowSubtitle } from "../../state/sync/syncRules";
import { settingsRouteKey, type SettingsRoute } from "../../state/settings/nav";
import { neverBounces, contentMargins, modifierList, settingsChrome, settingsLayout, SettingsIconTile, settingsTint, settingsUIAvailable, useWarningInk, type SettingsTintName } from "../ui";
import { ExpoPaneLabel } from "./ExpoRowLabel";
import { ExpoSettingsDone } from "./ExpoSettingsDone";
import { syncOffered } from "../../state/sync/offer";
import { browseForMeOffered } from "../../state/browseForMe/store";
import { pageSummariesSwitchable } from "../../state/pageSummary/enabled";
import { destinationWords } from "../../lib/sharedWords";

type SettingsPaneRoute = Extract<SettingsRoute["page"], "general" | "tabs" | "appearance" | "search" | "siteSettings" | "experimental">;

type PaneLook = { page: SettingsPaneRoute; title: string; systemImage: string; tint: SettingsTintName };

const SETTINGS_PANES: readonly PaneLook[] = [
  { page: "general", title: "General", systemImage: "gearshape.fill", tint: "neutral" },
  { page: "tabs", title: "Tabs", systemImage: "square.on.square.fill", tint: "orange" },
  { page: "appearance", title: "Appearance", systemImage: "circle.lefthalf.filled", tint: "nightShade" },
  { page: "search", title: "Search", systemImage: "magnifyingglass", tint: "blue" },
  { page: "siteSettings", title: "Site settings", systemImage: "globe", tint: "bottomBar" },
  { page: "experimental", title: "Experimental", systemImage: "sparkles", tint: "purple" },
];

const SYNC_TILE = 56;
const TOP_SECTION_SPACING = 12;

const experimentalOffered = () => browseForMeOffered() || pageSummariesSwitchable();

const paneShown = (pane: PaneLook) => pane.page !== "experimental" || experimentalOffered();

export function ExpoSettingsRoot() {
  return (
    <ExpoSettingsDone>
      <Form modifiers={modifierList(navigationTitle(destinationWords.settings), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), neverBounces(), contentMargins({ edges: "top", length: settingsLayout.expoListTop }))}>
        {syncOffered() ? (
          <Section modifiers={[listSectionSpacing(TOP_SECTION_SPACING)]}>
            <NavigationLink value={settingsRouteKey({ page: "sync" })}>
              <SyncRow />
            </NavigationLink>
          </Section>
        ) : null}
        <Section>
          {SETTINGS_PANES.filter(paneShown).map((pane) => (
            <NavigationLink key={pane.page} value={settingsRouteKey({ page: pane.page })}>
              <ExpoPaneLabel title={pane.title} systemImage={pane.systemImage} tint={pane.tint} />
            </NavigationLink>
          ))}
        </Section>
      </Form>
    </ExpoSettingsDone>
  );
}

function SyncRow() {
  const warningInk = useWarningInk();
  const line = syncRowSubtitle(useSyncStatus());
  return (
    <HStack spacing={14} modifiers={[padding({ vertical: 6 }), accessibilityElement("combine")]}>
      {settingsUIAvailable() ? (
        <SettingsIconTile systemImage="macbook.and.iphone" tint="sync" baseSide={SYNC_TILE} />
      ) : (
        <Image systemName="macbook.and.iphone" size={SYNC_TILE / 2} color={settingsTint.sync} />
      )}
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ textStyle: "headline" })]}>{destinationWords.sync}</Text>
        <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(line.isWarning ? warningInk : { type: "hierarchical", style: "secondary" }), contentTransition("opacity")]}>{line.text}</Text>
      </VStack>
    </HStack>
  );
}
