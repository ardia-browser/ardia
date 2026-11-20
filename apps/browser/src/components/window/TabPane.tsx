import { memo, useEffect, useLayoutEffect } from "react";
import { Animated, View } from "react-native";
import { usePrewarm } from "../../state/tabs/prewarm";
import { activate } from "../../state/tabs/actions";
import { shallowEqual, useBrowserWhile, useStoreWhile, useTabValue } from "../../state/tabs/tabWatch";
import { splitOf } from "../../state/splits/splits";
import type { Tab } from "../../state/browser/types";
import { BookmarksBar, bookmarksBarShown, type BookmarksBarMode } from "../bookmarks/BookmarksBar";
import { useBookmarksBarHeight } from "../bookmarks/barSize";
import type { Rect, ToolbarGeometry } from "./geometry";
import { patchPage, usePages } from "../../state/tabs/pageState";
import { SplitEmptyState } from "../split/SplitEmptyState";
import { NewTabPage } from "../ntp/NewTabPage";
import { EmptyCard } from "./EmptyCard";
import { NewTabDropArea } from "./NewTabDropArea";
import { InternalPage } from "../pages";
import { ShareBar } from "../media/ShareBar";
import { Toolbar, ToolbarBackdrop } from "../toolbar/Toolbar";
import { AutoHideBackdrop, AutoHideToolbar, useToolbarMode, useToolbarMotion } from "../toolbar/AutoHideToolbar";
import { publishPaneChrome } from "../toolbar/WindowToolbar";
import { addressFieldShownIn, revealToolbar } from "../../state/windows/toolbarAutoHide";
import { TabWebView } from "./TabWebView";
import { withoutFragment } from "../../lib/url";
import { developerBarShown, paneBar, type CardChrome } from "./paneChrome";
import { DeveloperBar } from "../toolbar/DeveloperBar";
import { useDeveloperMode } from "../../state/site/developerMode";
import { PageOverlays } from "./PageOverlays";
import { useProfileTheme } from "./ThemeScope";
import { markNewTabPane } from "../../state/omnibox/newTabMarks";

const LINGERING_PANE = "ardia.lingeringPane";

export const TabPane = memo(function TabPane({
  tabId,
  windowId,
  rect,
  fills,
  fullWidth,
  fullHeight,
  focused,
  inActiveSplit,
  fullscreen,
  covered,
  geometry,
  chrome,
  small,
  mounted,
  warm,
  barMode,
  popovers,
  peekShown,
  lingering,
  seeThrough,
  sidebarFieldOpen,
  cardRadius,
  toolbarHeight,
  newTabCard,
}: {
  tabId: string;
  windowId: string;
  rect: Rect | undefined;
  fills: boolean;
  fullWidth: number;
  fullHeight: number;
  focused: boolean;
  inActiveSplit: boolean;
  fullscreen: boolean;
  covered: boolean;
  geometry: ToolbarGeometry;
  chrome: CardChrome;
  small: boolean;
  mounted: boolean;
  warm: Rect | undefined;
  barMode: BookmarksBarMode;
  popovers: boolean;
  peekShown: boolean;
  lingering: boolean;
  seeThrough: boolean;
  sidebarFieldOpen: boolean;
  cardRadius: number;
  toolbarHeight: number;
  newTabCard: boolean;
}) {
  const visible = !!rect;
  const live = visible || !!warm;
  const own = useTabValue(tabId, paneTab, shallowEqual);
  const theme = useProfileTheme(own.profileId);
  const isNewTab = !own.url;
  const emptyCard = isNewTab && newTabCard;
  const newTabShown = useStoreWhile(usePages, live, (s) => !!s.pages[tabId]?.newTabShown);
  const inSomeSplit = useBrowserWhile(!!warm, (s) => !!warm && !!splitOf(s, tabId));
  const inSplit = visible ? inActiveSplit : inSomeSplit;
  const frame = rect ?? warm ?? { x: 0, y: 0, width: fullWidth, height: fullHeight };
  useEffect(() => {
    if (visible && isNewTab && !mounted) patchPage(tabId, { wasNewTab: true });
  }, [visible, isNewTab, mounted]);
  useLayoutEffect(() => {
    markNewTabPane(tabId, "mounted");
    return () => markNewTabPane(tabId, "gone");
  }, []);
  useLayoutEffect(() => {
    if (isNewTab) markNewTabPane(tabId, `visible ${visible} small ${small} split ${inSplit} card ${emptyCard}`);
  }, [visible, isNewTab, small, inSplit, emptyCard]);
  const prewarmed = usePrewarm(visible && isNewTab && !emptyCard && !mounted && !small && !inSplit);
  const toolbar = chrome.kind !== "none";
  const bar = paneBar(chrome, { visible, fullscreen, lingering });
  const autoLayout = bar.kind === "autoHide";
  const hideBar = autoLayout && bar.bar !== null;
  const mode = useToolbarMode(tabId, windowId, hideBar);
  const addressFieldShown = bar.kind !== "none" && addressFieldShownIn(mode);
  const sidebarFieldShown = sidebarFieldOpen && !fullscreen && focused;
  const developerBar = developerBarShown(chrome, { developerMode: useDeveloperMode(own.url), small, fullscreen });
  const bookmarksBar = bookmarksBarShown(barMode, own.exists ? own : undefined) && !fullscreen && !inSplit && !small;
  const barHeight = useBookmarksBarHeight();
  const doc = withoutFragment(own.url);
  const motion = useToolbarMotion({ enabled: autoLayout, mode, extra: bookmarksBar ? barHeight : 0, doc });
  useEffect(() => {
    if (visible) revealToolbar(tabId);
  }, [visible]);
  useLayoutEffect(() => {
    if (autoLayout && bar.bar === "window") publishPaneChrome(windowId, { tabId, mode, bar: motion.bar, fade: motion.fade });
  });

  return (
    <View
      pointerEvents={visible && !covered && !lingering ? "auto" : "none"}
      nativeID={lingering ? LINGERING_PANE : undefined}
      onTouchStart={() => {
        if (visible && !focused) activate(tabId);
      }}
      style={{
        position: "absolute",
        ...(fills ? { left: 0, top: 0, right: 0, bottom: 0 } : { left: frame.x, top: frame.y, width: frame.width, height: frame.height }),
        borderRadius: fullscreen ? 0 : cardRadius,
        overflow: "hidden",
        opacity: covered ? 0 : 1,
        zIndex: lingering ? -1 : undefined,
        backgroundColor: visible && !fullscreen && !seeThrough ? theme.card : undefined,
      }}
    >
      {bar.kind === "toolbar" && <Toolbar tabId={tabId} geometry={geometry} windowId={windowId} inSplit={inSplit} focused={focused || !inSplit} />}
      {bar.kind === "backdrop" && <ToolbarBackdrop tabId={tabId} />}
      {bar.kind === "spacer" && <View style={{ height: toolbarHeight }} />}
      {developerBar && <DeveloperBar tabId={tabId} windowId={windowId} />}
      {!autoLayout && bookmarksBar && <BookmarksBar tabId={tabId} placeholder={!visible} />}
      <Animated.View style={autoLayout ? motion.groupStyle : { flex: 1 }}>
        {autoLayout && bookmarksBar && <BookmarksBar tabId={tabId} placeholder={!visible} />}
        <View style={{ flex: 1 }}>
          {visible && !fullscreen && <ShareBar tabId={tabId} />}
          <View style={{ flex: 1 }}>
            {(mounted || prewarmed) && <TabWebView tabId={tabId} visible={visible && !newTabShown && !isNewTab} selected={focused} warm={!!warm && !newTabShown && !isNewTab} />}
            {visible && isNewTab && !small && (
              <NewTabDropArea contentAreaOf={tabId} accepting={!covered && !lingering}>
                {inSplit ? <SplitEmptyState tabId={tabId} focused={focused} /> : emptyCard ? <EmptyCard windowId={windowId} tabId={tabId} /> : <NewTabPage key={tabId} tabId={tabId} toolbar={toolbar} />}
              </NewTabDropArea>
            )}
            {visible && <InternalPage contentAreaOf={tabId} />}
            {visible && (
              <PageOverlays
                tabId={tabId}
                windowId={windowId}
                width={frame.width}
                geometry={geometry}
                toolbar={toolbar}
                newTabShown={newTabShown}
                statusStyle={autoLayout ? motion.bottomStyle : undefined}
                popovers={popovers}
                cliPill={!peekShown && (fullscreen || focused || !inSplit)}
                loadingPill={!addressFieldShown && !sidebarFieldShown && !small}
              />
            )}
          </View>
        </View>
      </Animated.View>
      {hideBar && <AutoHideBackdrop tabId={tabId} mode={mode} motion={motion} />}
      {autoLayout && bar.bar === "pane" && <AutoHideToolbar tabId={tabId} geometry={geometry} windowId={windowId} inSplit={inSplit} focused={focused || !inSplit} mode={mode} motion={motion} />}
    </View>
  );
});

const paneTab = (t: Tab | undefined) => ({ exists: !!t, url: t?.url ?? "", profileId: t?.profileId ?? "" });
