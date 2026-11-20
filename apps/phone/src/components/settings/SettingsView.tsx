import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View, type ViewInstance } from "react-native";
import Animated, { Easing, FadeIn, FadeOut } from "react-native-reanimated";
import { refreshSettings } from "../../state/settings/actions";
import { useSettingsNav, type SettingsRoute } from "../../state/settings/hooks";
import { LookBackdrop } from "../ui";
import { materialEasing, materialMotion } from "../ui/materialTokens";
import { useCoverFocus } from "../ui/coverFocus";
import { FilterListDetailPage, FilterListsPage, MyFiltersPage, TrustedSitesPage } from "./BlockingPages";
import { AboutPage, ClearDataPage, LicensesPage } from "./DataPages";
import { AppearancePage } from "./AppearancePage";
import { SettingsRoot } from "./SettingsRoot";
import { SearchEnginePage, SiteSettingsPage } from "./SitePages";
import { SyncConnect } from "../sync/SyncConnect";
import { SyncScan } from "../sync/SyncScan";
import { haptics } from "../../state/app/haptics";
import { setConnectPhrase } from "../../state/sync/connectDraft";
import { SyncPage } from "../sync/SyncPage";
import { DefaultBrowserPage } from "./DefaultBrowserPage";
import { WhatsSentPage } from "./WhatsSentPage";
import { popSettings, pushSettings, settingsRouteKey } from "../../state/settings/nav";
import { ExpoSettingsStack } from "./ExpoSettingsStack";
import { BrowseForMePage } from "./BrowseForMePage";
import { PageSummaryPage } from "./PageSummaryPage";

const axisIn = Easing.bezier(...materialEasing[materialMotion.sharedAxisIn.easing]);
const axisOut = Easing.bezier(...materialEasing[materialMotion.sharedAxisOut.easing]);
const SCREEN_IN = FadeIn.duration(materialMotion.sharedAxisIn.durationMs).easing(axisIn);
const SCREEN_OUT = FadeOut.duration(materialMotion.sharedAxisOut.durationMs).easing(axisOut);

export function SettingsPageFor({ route }: { route: SettingsRoute }) {
  switch (route.page) {
    case "root":
      return <SettingsRoot />;
    case "appearance":
      return <AppearancePage />;
    case "searchEngine":
      return <SearchEnginePage />;
    case "siteSettings":
      return <SiteSettingsPage />;
    case "filterLists":
      return <FilterListsPage />;
    case "filterList":
      return <FilterListDetailPage id={route.id} />;
    case "myFilters":
      return <MyFiltersPage />;
    case "trustedSites":
      return <TrustedSitesPage />;
    case "clearData":
      return <ClearDataPage />;
    case "sync":
      return <SyncPage />;
    case "defaultBrowser":
      return <DefaultBrowserPage />;
    case "syncConnect":
      return <SyncConnect onClose={popSettings} onConnected={popSettings} />;
    case "syncWords":
      return <SyncConnect onClose={popSettings} onConnected={popSettings} />;
    case "syncScan":
      return (
        <SyncScan
          onScan={(text) => {
            haptics.success();
            setConnectPhrase(text);
            popSettings();
          }}
          onEnterWords={() => {
            popSettings();
            pushSettings({ page: "syncWords" });
          }}
          onCancel={popSettings}
        />
      );
    case "about":
      return <AboutPage />;
    case "licenses":
      return <LicensesPage />;
    case "whatsSent":
      return <WhatsSentPage />;
    case "browseForMe":
      return <BrowseForMePage />;
    case "pageSummary":
      return <PageSummaryPage />;
  }
}

export function SettingsView() {
  if (Platform.OS === "ios") return <ExpoSettingsStack />;
  return <HandBuiltSettings />;
}

export function MaterialSettingsScreen() {
  const screen = useRef<ViewInstance>(null);
  useCoverFocus(screen);
  return (
    <Animated.View ref={screen} testID="materialSettingsScreen" entering={SCREEN_IN} exiting={SCREEN_OUT} style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <HandBuiltSettings />
    </Animated.View>
  );
}

type ShownPage = { key: string; route: SettingsRoute };

const shownPageOf = (open: boolean, stack: readonly SettingsRoute[]): ShownPage | null => {
  const route = open ? stack[stack.length - 1] : undefined;
  return route ? { key: `${stack.length}:${settingsRouteKey(route)}`, route } : null;
};

function HandBuiltSettings() {
  const open = useSettingsNav((s) => s.open);
  const stack = useSettingsNav((s) => s.stack);
  useEffect(() => {
    if (open) void refreshSettings();
  }, [open]);
  const latest = shownPageOf(open, stack);
  const [lastShown, setLastShown] = useState<ShownPage | null>(latest);
  if (latest && latest.key !== lastShown?.key) setLastShown(latest);
  const shown = latest ?? lastShown;
  if (!shown) return null;
  return (
    <View testID="settingsStack" style={StyleSheet.absoluteFill}>
      <LookBackdrop />
      <View key={shown.key} testID="settingsPage" style={StyleSheet.absoluteFill}>
        <SettingsPageFor route={shown.route} />
      </View>
    </View>
  );
}
