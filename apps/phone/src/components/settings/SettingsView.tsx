import { useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { refreshSettings } from "../../state/settings/actions";
import { useSettingsNav, type SettingsRoute } from "../../state/settings/hooks";
import { FilterListDetailPage, FilterListsPage, MyFiltersPage, TrustedSitesPage } from "./BlockingPages";
import { AboutPage, ClearDataPage, LicensesPage } from "./DataPages";
import { AppearancePage } from "./AppearancePage";
import { ThemePage } from "./ThemePage";
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

export function SettingsPageFor({ route }: { route: SettingsRoute }) {
  switch (route.page) {
    case "root":
      return <SettingsRoot />;
    case "appearance":
      return <AppearancePage />;
    case "theme":
      return <ThemePage />;
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
      <View key={shown.key} testID="settingsPage" style={StyleSheet.absoluteFill}>
        <SettingsPageFor route={shown.route} />
      </View>
    </View>
  );
}
