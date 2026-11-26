import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { startChromeTabs } from "../../state/tabs/chromeTabs";
import { useIsSmallWindow, useSplitOf } from "../../state/windows/card";
import { usePeekOpenedFrom } from "../../state/peek/hooks";
import { useActiveTabId, useSettings, useTab, useTabsShown, useWindowFullScreen, useWindowId } from "../../state/browser/hooks";
import { useThemeLook } from "../../state/config/hooks";
import { sidebarFieldOf } from "../../state/sidebar/chrome";
import { useCurrentInterfaceScale } from "../../state/settings/interfaceScale";
import { newTabOpensOf } from "../../state/settings/settings";
import { cardFrameOf } from "./cardFrame";
import { useBookmarksBarHeight } from "../bookmarks/barSize";
import { useBookmarksBarMode } from "../../state/bookmarks/hooks";
import { POPOVER_MARGIN } from "../ui";
import { NO_TOOLBAR, toolbarGeometry, type Rect, type ToolbarGeometry } from "./geometry";
import { startPermissionPrompts } from "../../state/site/permissions";
import { useFullscreenTab } from "../../state/tabs/pageState";
import { DropTargets, SplitDividers, SplitFocusRing, SplitToast, type WindowShape } from "../split/SplitChrome";
import { dockMoving, usePeekSpan, whenDockStill } from "../../state/windows/dockMotion";
import { FrozenPage } from "./FrozenPage";
import { setCardAnchor, setUrlAnchor, useAddressBarInSidebar, useCardCaptionRoom, useMinimalism, usePageFrameInset, useTabLayout, watchToolbarExtensionsWidth, onFullScreenLeft, onInterfaceScaleChange, windowRootShape } from "../../state/windows/layout";
import { startSelectionTools } from "../../state/site/selection";
import { startPasswordManager } from "../../state/site/passwordManager";
import { startMedia } from "../../state/media/pip";
import { urlFieldRight } from "../toolbar/Toolbar";
import { WindowToolbar } from "../toolbar/WindowToolbar";
import { useToolbarRow } from "../toolbar/useToolbarRow";
import "../dev/devExpose";
import { PeekOverlay } from "../peek/PeekOverlay";
import { dismissPeek, startPeeks } from "../../state/peek/actions";
import { usePaneLayout } from "./usePaneLayout";
import { cardChrome, developerBarShown } from "./paneChrome";
import { DEVELOPER_BAR } from "../toolbar/tokens";
import { useDeveloperMode } from "../../state/site/developerMode";
import { TabPane } from "./TabPane";
import { PageBarPublisher, usePageBarScope } from "../plugins/PageBarScope";
import { PAGE_BAR_HEIGHT } from "../plugins/PluginPageBar";
import { BesidePeekPopovers, PeekPage } from "./PageOverlays";
import { besidePeekSpan } from "./pageAnchors";
import { splitTabIdsOf } from "../../state/splits/splits";
import { sameSize, useSettled, type Size } from "../ui/useSettled";
import { noteCardResizeLayout } from "../../state/telemetry/usage";

export function ContentCard() {
  const windowId = useWindowId();
  const activeId = useActiveTabId();
  const split = useSplitOf(activeId);
  const fullscreenTab = useFullscreenTab(windowId);
  const tabLayout = useTabLayout();
  const addressInSidebar = useAddressBarInSidebar();
  const small = useIsSmallWindow(windowId);
  const minimal = useMinimalism();
  const hideWhileScrolling = useSettings((st) => st.hideToolbarWhileScrolling);
  const showSidebarButton = useSettings((st) => st.showSidebarButton !== false);
  const barMode = useBookmarksBarMode(windowId);
  const toolbarRow = useToolbarRow();
  const barHeight = useBookmarksBarHeight();
  const frameInset = usePageFrameInset();
  const captionRoom = useCardCaptionRoom(frameInset);
  const frame = cardFrameOf(frameInset, useCurrentInterfaceScale());
  const sidebarField = sidebarFieldOf(useThemeLook(), addressInSidebar);
  const sidebarFieldOpen = useTabsShown(windowId) && !!sidebarField;
  const newTabCard = useSettings((st) => newTabOpensOf(st) === "commandBar");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [windowShape, setWindowShape] = useState<WindowShape | null>(null);
  const windowFullScreen = useWindowFullScreen(windowId);
  const container = useRef<View>(null);
  useEffect(startPermissionPrompts, []);
  useEffect(startChromeTabs, []);
  useEffect(startMedia, []);
  useEffect(startSelectionTools, []);
  useEffect(startPasswordManager, []);
  useEffect(startPeeks, []);
  const peekId = usePeekOpenedFrom(activeId ?? "");
  const peekFullscreen = !!peekId && fullscreenTab === peekId;
  useEffect(() => {
    if (fullscreenTab && peekId && !peekFullscreen) dismissPeek(windowId);
  }, [fullscreenTab, peekId, peekFullscreen, windowId]);

  const { mountedIds, panes, dividers, warmPanes, shown, lingerId, lingerRect } = usePaneLayout(windowId, activeId, split, fullscreenTab, size, frame.splitGap);

  const chrome = useMemo(
    () => cardChrome({ addressInSidebar, small, minimal, split: !!split, fullscreen: !!fullscreenTab, hideWhileScrolling }),
    [addressInSidebar, small, minimal, !!split, !!fullscreenTab, hideWhileScrolling],
  );
  const activeDeveloperMode = useDeveloperMode(useTab(activeId, (t) => t?.url ?? ""));
  const { wanted: pageBarsWanted, bars: pageBars } = usePageBarScope();
  const paneFacts = pageBarsWanted
    ? shown.map((key) => {
        const tabId = key.slice(0, key.indexOf("|"));
        const visible = !!panes[tabId] || (tabId === lingerId && !!lingerRect);
        return { tabId, visible, lingering: tabId === lingerId, warm: !visible && !!warmPanes[tabId], covered: !!fullscreenTab && tabId !== fullscreenTab, mounted: mountedIds.has(tabId), documentFullscreen: tabId === fullscreenTab };
      })
    : null;
  const activePageBar = chrome.kind === "none" && activeId && pageBars[activeId] ? PAGE_BAR_HEIGHT : 0;
  const activeDeveloperBar = developerBarShown(chrome, { developerMode: activeDeveloperMode, small, fullscreen: false }) ? DEVELOPER_BAR.height : activePageBar;
  const geometryFor = (rect: Rect | undefined): ToolbarGeometry => {
    if (chrome.kind === "none") return NO_TOOLBAR;
    const leading = !!rect && rect.x === 0 && rect.y === 0;
    const trailing = !!rect && rect.y === 0 && rect.x + rect.width === size.width ? captionRoom : 0;
    return toolbarGeometry({ sidebarButton: leading && showSidebarButton, trailing, cardRadius: frame.radius, leadingAtCardCorner: leading });
  };

  const focusedRect = activeId ? panes[activeId] : undefined;
  useEffect(() => {
    if (!origin || !focusedRect || chrome.kind === "none") return;
    const g = geometryFor(focusedRect);
    const place = (extensionsWidth = 0) =>
      setUrlAnchor(windowId, {
        left: origin.x + focusedRect.x + g.urlLeft,
        top: origin.y + focusedRect.y,
        width: focusedRect.width - g.urlLeft - urlFieldRight(!!split, extensionsWidth, toolbarRow, g.cardRadius) - g.trailing,
      });
    return watchToolbarExtensionsWidth(windowId, place);
  }, [origin, focusedRect?.x, focusedRect?.y, focusedRect?.width, tabLayout, chrome.kind, !!split, showSidebarButton, toolbarRow, captionRoom, frame.radius]);

  useEffect(() => {
    if (origin && size.width > 0) setCardAnchor(windowId, { left: origin.x, top: origin.y, width: size.width, height: size.height });
  }, [origin, size.width, size.height, windowId]);

  const settled = useRef<{ width: number; height: number } | null>(null);
  const measureWindowShape = () =>
    void windowRootShape(windowId).then((shape) => {
      if (shape) setWindowShape((prev) => (prev && prev.radius === shape.radius && sameSize(prev, shape) ? prev : shape));
    });
  useEffect(() => onFullScreenLeft(windowId, measureWindowShape), [windowId]);
  useEffect(() => onInterfaceScaleChange(measureWindowShape), [windowId]);
  const measure = (width: number, height: number) => {
    setSize((prev) => (sameSize(prev, { width, height }) ? prev : { width, height }));
    container.current?.measureInWindow((x, y) => setOrigin((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y })));
    measureWindowShape();
  };
  const settleMeasure = useSettled(({ width, height }: Size) => {
    noteCardResizeLayout(true);
    measure(width, height);
  });
  useEffect(
    () =>
      whenDockStill(windowId, () => {
        if (!settled.current) return;
        const { width, height } = settled.current;
        settled.current = null;
        measure(width, height);
      }),
    [windowId],
  );

  const peek = usePeekSpan(windowId);
  const activeRect = activeId ? panes[activeId] : undefined;
  const popoversOverCard = peek !== undefined && addressInSidebar && !small && !fullscreenTab && origin && activeRect ? activeId : undefined;

  return (
    <View
      ref={container}
      style={{ flex: 1 }}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (size.width > 0 && dockMoving(windowId) && !split) {
          settleMeasure.cancel();
          settled.current = { width, height };
        } else if (size.width > 0 && !split && !peekId) {
          noteCardResizeLayout(false);
          settleMeasure({ width, height });
        } else {
          settleMeasure.cancel();
          measure(width, height);
        }
      }}
    >
      {paneFacts && <PageBarPublisher windowId={windowId} panes={paneFacts} small={small} fullscreen={windowFullScreen} />}
      {size.width > 0 &&
        shown.map((key) => {
          const tabId = key.slice(0, key.indexOf("|"));
          const rect = panes[tabId] ?? (tabId === lingerId ? lingerRect : undefined);
          return (
            <TabPane
              key={key}
              tabId={tabId}
              windowId={windowId}
              rect={rect}
              fills={!!rect && rect.x === 0 && rect.y === 0 && rect.width === size.width && rect.height === size.height}
              fullWidth={size.width}
              fullHeight={size.height}
              focused={tabId === activeId}
              inActiveSplit={!!splitTabIdsOf(split)?.includes(tabId)}
              fullscreen={tabId === fullscreenTab}
              covered={!!fullscreenTab && tabId !== fullscreenTab}
              geometry={geometryFor(rect)}
              chrome={chrome}
              small={small}
              mounted={mountedIds.has(tabId)}
              warm={warmPanes[tabId]}
              barMode={barMode}
              popovers={tabId !== popoversOverCard}
              peekShown={!!peekId}
              lingering={tabId === lingerId}
              seeThrough={!!lingerId && tabId === activeId}
              pageBar={chrome.kind === "none" ? (pageBars[tabId] ?? null) : null}
              sidebarFieldOpen={sidebarFieldOpen}
              cardRadius={frame.radius}
              toolbarHeight={toolbarRow.height}
              newTabCard={newTabCard}
            />
          );
        })}
      {size.width > 0 && chrome.kind === "window" && activeId && panes[activeId] && (
        <WindowToolbar windowId={windowId} tabId={activeId} geometry={geometryFor(panes[activeId])} autoHide={chrome.autoHide} />
      )}
      {size.width > 0 && !split && !fullscreenTab && (
        <FrozenPage windowId={windowId} tabId={activeId} top={(chrome.kind !== "none" && !chrome.autoHide ? toolbarRow.height : activeDeveloperBar) + (barMode === "always" && !small && !hideWhileScrolling ? barHeight : 0)} />
      )}
      {split && !fullscreenTab && <SplitDividers split={split} dividers={dividers} width={size.width} height={size.height} />}
      {split && !fullscreenTab && activeRect && <SplitFocusRing rect={activeRect} origin={origin} windowShape={windowFullScreen ? null : windowShape} />}
      {size.width > 0 && popoversOverCard && origin && activeRect && peek !== undefined && (
        <BesidePeekPopovers
          tabId={popoversOverCard}
          windowId={windowId}
          {...besidePeekSpan(peek, origin.x, size.width, activeRect)}
          top={activeRect.y + POPOVER_MARGIN}
        />
      )}
      {!fullscreenTab && <DropTargets panes={panes} origin={origin} />}
      {!small && (
        <PeekOverlay
          windowId={windowId}
          width={size.width}
          height={size.height}
          origin={origin}
          activeTabId={activeId}
          fullscreenTabId={fullscreenTab}
          page={(tabId, sourceId, width, shown, fullscreen) => <PeekPage tabId={tabId} sourceId={sourceId} windowId={windowId} width={width} shown={shown} fullscreen={fullscreen} />}
        />
      )}
      <SplitToast windowId={windowId} />
    </View>
  );
}
