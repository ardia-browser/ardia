import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { BottomSheet, Host, NavigationDestination, NavigationStack, RNHostView, VStack } from "@expo/ui/swift-ui";
import { ignoreSafeArea, navigationBarTitleDisplayMode, navigationTitle } from "@expo/ui/swift-ui/modifiers";
import { refreshSettings } from "../../state/settings/actions";
import { useSettingsNav } from "../../state/settings/hooks";
import { closeSettings, followSettingsPath, settingsPath, settingsRouteFromKey, type SettingsRoute } from "../../state/settings/nav";
import { nativeLookColors } from "../../lib/profileLook";
import { PHONE_SHARING_COPY } from "../../lib/telemetryCopy";
import { destinationWords, syncWords } from "../../lib/sharedWords";
import { LookBackdrop, modifierList, profileLook, settingsChrome, settingsUIAvailable, useProfileLook, useTheme } from "../ui";
import { useNativeChromeUsesGlass, usePublishNativeChromeLook } from "./nativeChromeLook";
import { ExpoAppearancePage } from "./ExpoAppearancePage";
import { ExpoSiteSettingsPage } from "./ExpoSiteSettingsPage";
import { ExpoSyncPage } from "./ExpoSyncPage";
import { ExpoSyncConnectPage } from "./ExpoSyncConnectPage";
import { ExpoPhrasePage } from "./ExpoPhrasePage";
import { ExpoSearchEnginePage } from "./ExpoSearchEnginePage";
import { ExpoBrowseForMePage } from "./ExpoBrowseForMePage";
import { ExpoFilterListPage, ExpoFilterListsPage, ExpoMyFiltersPage, ExpoTrustedSitesPage } from "./ExpoBlockingPages";
import { ExpoClearDataPage } from "./ExpoClearDataPage";
import { ExpoAboutPage, ExpoLicensesPage } from "./ExpoAboutPages";
import { ExpoDefaultBrowserPage, ExpoWhatsSentPage } from "./ExpoInfoPages";
import { ExpoSettingsRoot } from "./ExpoSettingsRoot";
import { ExpoSettingsDone } from "./ExpoSettingsDone";
import { SettingsHostedContext } from "./SettingsKit";
import { SettingsPageFor } from "./SettingsView";

const CONVERTED: Partial<Record<SettingsRoute["page"], (props: { route: SettingsRoute }) => React.JSX.Element>> = {
  appearance: ExpoAppearancePage,
  siteSettings: ExpoSiteSettingsPage,
  sync: ExpoSyncPage,
  syncConnect: ExpoSyncConnectPage,
  syncWords: ExpoPhrasePage,
  searchEngine: ExpoSearchEnginePage,
  browseForMe: ExpoBrowseForMePage,
  filterLists: ExpoFilterListsPage,
  filterList: ExpoFilterListPage,
  trustedSites: ExpoTrustedSitesPage,
  myFilters: ExpoMyFiltersPage,
  clearData: ExpoClearDataPage,
  defaultBrowser: ExpoDefaultBrowserPage,
  about: ExpoAboutPage,
  licenses: ExpoLicensesPage,
  whatsSent: ExpoWhatsSentPage,
};

const TITLES: Record<SettingsRoute["page"], string> = {
  root: destinationWords.settings,
  appearance: "Appearance",
  theme: "Theme",
  searchEngine: "Search Engine",
  browseForMe: "Browse for Me",
  pageSummary: "Pinch to Summarize",
  siteSettings: "Site Settings",
  filterLists: "Filter Lists",
  filterList: "Filter List",
  myFilters: "My Filters",
  trustedSites: "Trusted Sites",
  clearData: "Clear Browsing Data",
  sync: destinationWords.sync,
  defaultBrowser: "Default Browser",
  syncConnect: syncWords.connect,
  syncWords: syncWords.enterRecoveryPhrase,
  syncScan: syncWords.scanCode,
  about: "About Ardia",
  licenses: "Open Source Licenses",
  whatsSent: PHONE_SHARING_COPY.whatsSent,
};

export function ExpoSettingsStack() {
  const open = useSettingsNav((s) => s.open);
  useRefreshWhileOpen(open);
  if (!open) return null;
  return (
    <View testID="expoSettings" style={StyleSheet.absoluteFill}>
      {settingsUIAvailable() ? null : <LookBackdrop />}
      <Host style={styles.fill}>
        <SettingsNavigation />
      </Host>
    </View>
  );
}

export function ExpoSettingsSheet() {
  const open = useSettingsNav((s) => s.open);
  useRefreshWhileOpen(open);
  usePublishNativeChromeLook();
  return (
    <Host testID="expoSettingsSheet" style={styles.anchor} pointerEvents="none">
      <BottomSheet isPresented={open} onIsPresentedChange={(presented) => (presented ? undefined : closeSettings())}>
        <SettingsNavigation />
      </BottomSheet>
    </Host>
  );
}

function useRefreshWhileOpen(open: boolean) {
  useEffect(() => {
    if (open) void refreshSettings();
  }, [open]);
}

function SettingsNavigation() {
  const open = useSettingsNav((s) => s.open);
  const stack = useSettingsNav((s) => s.stack);
  const look = useProfileLook();
  const dark = useTheme().dark;
  const glass = useNativeChromeUsesGlass();
  const kept = useRef(stack);
  if (open && stack.length) kept.current = stack;
  const path = settingsPath(open ? stack : kept.current);
  return (
    <NavigationStack path={path} onPathChange={followSettingsPath} modifiers={modifierList(profileLook({ ...nativeLookColors(look, dark), usesGlass: glass }))}>
      <StackRoot route={(open ? stack : kept.current)[0]} />
      {path.map((key) => (
        <NavigationDestination key={key} value={key}>
          <Destination routeKey={key} />
        </NavigationDestination>
      ))}
    </NavigationStack>
  );
}

const BRINGS_OWN_DISMISS = new Set<SettingsRoute["page"]>(["syncConnect"]);

function StackRoot({ route }: { route: SettingsRoute | undefined }) {
  const Converted = route && route.page !== "root" ? CONVERTED[route.page] : undefined;
  if (!route || !Converted) return <ExpoSettingsRoot />;
  if (BRINGS_OWN_DISMISS.has(route.page)) return <Converted route={route} />;
  return (
    <ExpoSettingsDone>
      <Converted route={route} />
    </ExpoSettingsDone>
  );
}

function Destination({ routeKey }: { routeKey: string }) {
  const route = settingsRouteFromKey(routeKey);
  if (!route) return null;
  const Converted = CONVERTED[route.page];
  if (Converted) return <Converted route={route} />;
  return (
    <VStack modifiers={modifierList(navigationTitle(TITLES[route.page]), navigationBarTitleDisplayMode("inline"), ignoreSafeArea({ edges: "bottom" }), settingsChrome())}>
      <RNHostView>
        <View style={styles.fill}>
          <SettingsHostedContext.Provider value>
            <SettingsPageFor route={route} />
          </SettingsHostedContext.Provider>
        </View>
      </RNHostView>
    </VStack>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  anchor: { position: "absolute", width: 0, height: 0 },
});
