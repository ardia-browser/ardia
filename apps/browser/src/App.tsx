import { WindowBackdrop } from "./components/ui";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet } from "react-native";
import { CommandPanel } from "./components/omnibox/CommandPanel";
import { windowOverlays } from "./components/window/WindowOverlays";
import { ContentCard } from "./components/window/ContentCard";
import { browserWindowControls } from "./components/window/BrowserWindowControls";
import { FolderMenus } from "./components/bookmarks/FolderMenus";
import { ExtensionSidePanel } from "./components/extensions/SidePanel";
import { PluginSidePanel } from "./components/plugins/PluginSidePanel";
import { PluginOverlays } from "./components/plugins/PluginOverlays";
import { PLUGIN_CHROME, PluginChromeContext, usePluginChrome, usePluginChromeOf } from "./state/plugins/chrome";
import { CrxDropArea } from "./components/extensions/CrxDropArea";
import { WindowPopups } from "./components/window/WindowPopups";
import { UtilityWindow } from "./components/settings/UtilityWindow";
import { isUtilityWindowId } from "./state/settings/settingsWindows";
import { OnboardingOverlay } from "./components/onboarding";
import { useFullscreenTab } from "./state/tabs/pageState";
import { ProfileTint } from "./components/window/ProfileSwipe";
import { TOP_STRIP_HEIGHT, TopStripPeek, TopTabStrip } from "./components/tabstrip/TopTabStrip";
import { useCardTopInset, usePageFrameInset, useTabLayout } from "./state/windows/layout";
import { WindowProfile } from "./components/window/WindowProfile";
import { DockedLayout } from "./components/window/SidebarDock";
import { LittleArdiaWindow } from "./components/littleArdia/LittleArdiaWindow";
import { SidebarOverlays } from "./components/sidebar/Overlays";
import { ReportSheetHost } from "./components/report/ReportSheet";
import { profileAccent, profileTheme, useTheme } from "./components/ui/theme";
import { ThemeScope } from "./components/window/ThemeScope";
import { PageBarContext, usePageBarScopeValue } from "./components/plugins/PageBarScope";
import { useBrowser } from "./state/browser/store";
import { useWindowId, WindowContext } from "./state/browser/hooks";
import { provideProfileLooks } from "./state/profiles/looks";
import { currentBasePalette } from "./state/config/basePalette";
import { focusedWindowOf } from "./state/windows/ui";
import { SETTLE_MS, useSettled } from "./components/ui/useSettled";
import { forgetWindowRootSize, setWindowRootSize } from "./state/windows/rootSize";

provideProfileLooks({ accent: profileAccent, theme: (profile, appDark, source) => profileTheme(profile, appDark, source, currentBasePalette()) });

export function WindowRoot({ windowId }: { windowId?: string }) {
  if (isUtilityWindowId(windowId))
    return (
      <ThemeScope>
        <UtilityWindow id={windowId!} />
      </ThemeScope>
    );
  return <BrowserWindowRoot windowId={windowId} />;
}

function BrowserWindowRoot({ windowId }: { windowId?: string }) {
  const id = useBrowser((s) => windowId ?? focusedWindowOf(s) ?? s.windowOrder[0] ?? null);
  const exists = useBrowser((s) => !!id && !!s.windows[id]);
  const small = useBrowser((s) => !!id && s.windows[id]?.kind === "small");
  const pluginChrome = usePluginChromeOf(id ?? "");
  const pageBars = usePageBarScopeValue(exists ? id : null, !small && (pluginChrome & PLUGIN_CHROME.pageBars) !== 0);
  if (!id || !exists) return null;
  return (
    <WindowContext.Provider value={id}>
      <PluginChromeContext.Provider value={small ? pluginChrome & PLUGIN_CHROME.verificationCodes : pluginChrome}>
        <PageBarContext.Provider value={pageBars}>
          <ThemeScope>{small ? <LittleArdiaWindow /> : <BrowserWindow />}</ThemeScope>
        </PageBarContext.Provider>
      </PluginChromeContext.Provider>
    </WindowContext.Provider>
  );
}

function BrowserWindow() {
  const theme = useTheme();
  const windowId = useWindowId();
  const topTabs = useTabLayout() === "top";
  const fullscreen = !!useFullscreenTab(windowId);
  const pluginPanels = usePluginChrome(PLUGIN_CHROME.panels);
  const pluginOverlays = usePluginChrome(PLUGIN_CHROME.overlays);
  const frame = usePageFrameInset();
  const cardTop = useCardTopInset(frame);
  const [width, setWidth] = useState(0);
  const settleWidth = useSettled(setWidth, topTabs ? 0 : SETTLE_MS);
  useEffect(() => () => forgetWindowRootSize(windowId), [windowId]);
  const card = useMemo(
    () => (
      <>
        <ContentCard />
        {!fullscreen && <ExtensionSidePanel />}
        {pluginPanels ? <PluginSidePanel hidden={fullscreen} /> : null}
      </>
    ),
    [fullscreen, pluginPanels],
  );

  return (
    <CrxDropArea style={{ flex: 1, flexDirection: "row" }} onLayout={(e) => (setWindowRootSize(windowId, e.nativeEvent.layout.width, e.nativeEvent.layout.height), settleWidth(e.nativeEvent.layout.width))}>
      <WindowBackdrop vibrancy {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
      <WindowProfile />
      <ProfileTint />
      <DockedLayout
        fullscreen={fullscreen}
        topTabs={topTabs}
        inset={{ top: topTabs ? TOP_STRIP_HEIGHT : cardTop, right: frame, bottom: frame, left: frame }}
        windowWidth={width}
        topStrip={
          topTabs
            ? { strip: <TopTabStrip width={width} hidden={fullscreen} />, peek: <TopStripPeek windowWidth={width} enabled={!fullscreen} /> }
            : undefined
        }
      >
        {card}
      </DockedLayout>
      <CommandPanel windowWidth={width} />
      {windowOverlays(
        <>
          <FolderMenus />
          <WindowPopups plugins={pluginOverlays ? <PluginOverlays /> : null} />
          <SidebarOverlays windowWidth={width} />
        </>,
      )}
      <OnboardingOverlay />
      {windowOverlays(<ReportSheetHost />)}
      {browserWindowControls()}
    </CrxDropArea>
  );
}
