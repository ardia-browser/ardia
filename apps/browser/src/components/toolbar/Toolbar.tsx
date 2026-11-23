import { colorDistance } from "../../lib/color";
import { pageHostLabel, urlTrail, withoutUserInfo } from "../../lib/url";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Animated, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { useTheme } from "../ui/theme";
import { TOOLBAR_ROWS, toolbarTrailing, urlFieldOf, type ToolbarRow } from "../../lib/toolbarRow";
import { ToolbarRowContext } from "../ui/toolbarRowContext";
import { activate } from "../../state/tabs/actions";
import { toggleSidebar } from "../../state/windows/actions";
import { openBarFromAddress } from "../../state/omnibox/barState";
import { useIsBookmarked, useSettings, useTab, useTabLive, useTabsPlace, useTabsShown } from "../../state/browser/hooks";
import type { Tab } from "../../state/browser/types";
import { Button, ContextMenuArea, Divider, FadeLabel, ink, monoFace, sidebarFont, sidebarPoints, drawnSymbol, space, Text, useHover, WindowDragRegion } from "../ui";
import { type ToolbarGeometry } from "../window/geometry";
import { usePage, usePages, type PageState } from "../../state/tabs/pageState";
import { togglePopover } from "../../state/tabs/popoverDismiss";
import { useHistoryAvailability } from "../../state/tabs/navigation";
import { toggleBookmarkOfTab } from "../../state/bookmarks/actions";
import { useBookmarksShown } from "../../state/bookmarks/hooks";
import { copyPageUrl } from "../../state/site/selection";
import { openSplitPane, pressClosePane, showSplitMenu } from "../../state/splits/actions";
import { useSplitOrientation } from "../../state/splits/hooks";
import { splitViewAvailable } from "../../state/splits/splits";
import { useEasedColor, type ToolbarPalette } from "../ui/toolbarColors";
import { useSitePalette } from "./useSitePalette";
import { setToolbarExtensionsWidth } from "../../state/windows/layout";
import { SIDEBAR_FIELD } from "../sidebar/geometry";
import { FieldSiteButton, SidebarFieldFill } from "../sidebar/SidebarField";
import { showUrlBarMenu } from "../../state/omnibox/paste";
import { ToolbarExtensions, useToolbarExtensionsWidth } from "../extensions/ToolbarExtensions";
import { PluginToolbarItems } from "../plugins/PluginToolbarItems";
import { PLUGIN_CHROME, usePluginChrome } from "../../state/plugins/chrome";
import { GlassFill, useGlass } from "../ui/Glass";
import { TranslateButton } from "../site/TranslateControls";
import { ReaderButton, useReaderButtonShown } from "../site/ReaderControls";
import { ZoomIndicator } from "../site/ZoomControls";
import { NAV_HINTS, useShortcutHint, useShortcutHints, withShortcut } from "../../state/commands/commandShortcuts";
import { curve } from "../ui/motion";
import { FieldLoadFill } from "./FieldLoadFill";
import { fieldButtonsShown, sidebarFieldButtons } from "./fieldButtons";
import { useFieldExtensionsHeld } from "../../state/extensions/store";
import { noteSiteControls } from "../../state/telemetry/usage";
import { HistoryButton, ReloadButton } from "./NavButtons";
import { FIELD_LOAD, TOOLBAR_MOTION } from "./tokens";
import { useToolbarRow } from "./useToolbarRow";
import { useStableHandler } from "./useStableHandler";
import { PAGE_IDENTITY_TAG } from "../../state/tabs/tabReveal";
import { DeveloperToolsButtons } from "./DeveloperToolsButtons";
import { TabSwipeArea } from "../window/TabSwipe";
import { useDeveloperMode } from "../../state/site/developerMode";
import { PageBarFieldButtons, usePageBarOf } from "../plugins/PageBarScope";

type ToolbarTab = Pick<Tab, "id" | "url" | "title" | "windowId" | "zoom">;
const toolbarTab = (t: Tab | undefined): ToolbarTab | undefined =>
  t && { id: t.id, url: t.url, title: isWebUrl(t.url) ? "" : t.title, windowId: t.windowId, zoom: t.zoom };
const isWebUrl = (url: string) => /^https?:/i.test(url);
export const useToolbarTab = (tabId: string | undefined) => useTab(tabId, useShallow(toolbarTab));

export const urlFieldRight = (inSplit: boolean, extensionsWidth: number, row: ToolbarRow, cardRadius: number) =>
  toolbarTrailing(row, { pinnedWidth: extensionsWidth, split: inSplit, cardRadius }).fieldRight;
const LOCK = { left: 7, width: 18, gap: space.xs } as const;
const SIDEBAR_TEXT_GAP = 6;
const SIDEBAR_TEXT_ALONE = space.ml;
export const urlTextLeft = (insecure: boolean) => (insecure ? LOCK.left + LOCK.width + LOCK.gap : 8);
export const insecureLevel = (p: PageState) =>
  p.security && (p.security.level === "insecure" || p.security.level === "certificateError") ? p.security.level : null;

function useTabsToggleIcon(windowId: string) {
  const place = useTabsPlace(windowId);
  return place === "top" ? "rectangle.topthird.inset.filled" : place === "right" ? "sidebar.right" : "sidebar.left";
}

const TOOLBAR_HINTS = ["toggleSidebar", "openSplitPane", ...NAV_HINTS] as const;

export const Toolbar = memo(function Toolbar({
  tabId,
  geometry,
  windowId,
  inSplit,
  focused,
  bare,
  loadFill = true,
}: {
  tabId: string;
  geometry: ToolbarGeometry;
  windowId: string;
  inSplit: boolean;
  focused: boolean;
  bare?: boolean;
  loadFill?: boolean;
}) {
  const hints = useShortcutHints(TOOLBAR_HINTS);
  const tabsIcon = useTabsToggleIcon(windowId);
  const tabsShown = useTabsShown(windowId);
  const tab = useToolbarTab(tabId);
  const splitOrientation = useSplitOrientation(inSplit ? tabId : undefined);
  const isLoading = useTabLive(tabId, (l) => l.isLoading);
  const palette = useSitePalette(tabId);
  const band = useEasedColor(bare ? null : palette.background);
  const history = useHistoryAvailability(tabId);
  const row = useToolbarRow();
  const extensionsWidth = useToolbarExtensionsWidth(windowId, Infinity);
  const pluginToolbar = usePluginChrome(PLUGIN_CHROME.toolbar);
  const [reportedPluginsWidth, setPluginsWidth] = useState(0);
  const pluginsWidth = pluginToolbar ? reportedPluginsWidth : 0;
  const trailingWidth = extensionsWidth + pluginsWidth;
  useEffect(() => setToolbarExtensionsWidth(windowId, trailingWidth), [windowId, trailingWidth]);
  const dim = useRef(new Animated.Value(focused ? 1 : 0.5)).current;
  const dimmedFor = useRef(focused);
  useEffect(() => {
    if (dimmedFor.current === focused) return;
    dimmedFor.current = focused;
    Animated.timing(dim, { toValue: focused ? 1 : 0.5, duration: TOOLBAR_MOTION.dim, easing: curve.enter, useNativeDriver: true }).start();
  }, [focused]);
  const focus = useStableHandler(() => {
    if (!focused) activate(tabId);
  });
  const toggleTabs = useCallback(() => toggleSidebar(windowId), [windowId]);
  const splitMenu = useCallback(() => showSplitMenu(tabId), [tabId]);
  const closeThisPane = useCallback(() => pressClosePane(tabId), [tabId]);
  const at = useMemo(() => {
    const top = row.center - row.button / 2;
    const place = (center: number | null) => ({ position: "absolute" as const, top, left: (center ?? 0) - row.button / 2 });
    const hit = { width: row.button, height: row.button, plateX: 0, plateY: 0, box: row.button, radius: row.buttonRadius };
    const nav = (center: number | null) => ({ style: place(center), hit });
    return { top, sidebarButton: place(geometry.sidebarButton), back: nav(geometry.back), forward: nav(geometry.forward), reload: nav(geometry.reload) };
  }, [geometry, row]);
  const trailing = useMemo(
    () => toolbarTrailing(row, { pinnedWidth: trailingWidth, split: inSplit, cardRadius: geometry.cardRadius }),
    [row, trailingWidth, inSplit, geometry.cardRadius],
  );
  const right = trailing.fieldRight + geometry.trailing;
  const extensionsRight = trailing.extensionsRight + geometry.trailing;
  const urlStyle = useMemo(() => ({ position: "absolute" as const, left: geometry.urlLeft, right, top: urlFieldOf(row).top }), [geometry.urlLeft, right, row]);
  if (!tab) return <View style={{ height: row.height }} />;

  return (
    <View style={{ height: row.height }}>
      {!bare && <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: band }]} />}
      <WindowDragRegion style={StyleSheet.absoluteFill} />
      <TabSwipeArea windowId={windowId} surface="toolbar" />
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: dim }]} pointerEvents="box-none">
        {geometry.sidebarButton !== null && (
          <Button variant="icon" toolbar style={at.sidebarButton} palette={palette} icon={tabsIcon} look="row" onPress={toggleTabs} tooltip={withShortcut(tabsShown ? "Hide Tabs" : "Show Tabs", hints.toggleSidebar)} />
        )}
        <HistoryButton place={at.back} tabId={tab.id} windowId={tab.windowId} direction={-1} disabled={!history.back} palette={palette} onFocus={focus} closesTab={history.backCloses} historyHint={hints.back} />
        <HistoryButton place={at.forward} tabId={tab.id} windowId={tab.windowId} direction={1} disabled={!history.forward} palette={palette} onFocus={focus} historyHint={hints.forward} />
        <ReloadButton place={at.reload} tab={tab} loading={isLoading} palette={palette} onFocus={focus} reloadHint={hints.reload} />
        <ToolbarExtensions tabId={tab.id} windowId={windowId} palette={palette} top={row.center - row.extensionButton / 2} right={extensionsRight} />
        {pluginToolbar ? <PluginToolbarItems windowId={windowId} palette={palette} top={row.center - row.extensionButton / 2} right={extensionsRight + extensionsWidth} onWidth={setPluginsWidth} /> : null}
        <View nativeID={PAGE_IDENTITY_TAG} collapsable={false} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {tab.url ? (
            <ToolbarUrlField tab={tab} palette={palette} windowId={windowId} inSplit={inSplit} loadFill={loadFill} onFocus={focus} style={urlStyle} splitHint={hints.openSplitPane} />
          ) : null}
        </View>
        {inSplit && (
          <View style={{ position: "absolute", top: at.top, right: trailing.splitRight + geometry.trailing, flexDirection: "row" }}>
            <Button variant="icon" toolbar palette={palette} icon={splitOrientation === "vertical" ? "rectangle.split.1x2" : "rectangle.split.2x1"} look="row" onPress={splitMenu} tooltip="Split View" />
            <Button variant="icon" toolbar palette={palette} icon="xmark" look="row" weight="medium" onPress={closeThisPane} tooltip="Close Pane" />
          </View>
        )}
      </Animated.View>

      {tab.url && !bare ? <Divider color={palette.divider} style={BOTTOM_LINE} /> : null}
    </View>
  );
});

const BOTTOM_LINE = { position: "absolute", left: 0, right: 0, bottom: 0 } as const;

export function ToolbarBackdrop({ tabId }: { tabId: string }) {
  const url = useTab(tabId, (t) => t?.url ?? "");
  const palette = useSitePalette(tabId);
  const band = useEasedColor(palette.background);
  const row = useToolbarRow();
  return (
    <View pointerEvents="none" style={{ height: row.height }}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: band }]} />
      {url ? <Divider color={palette.divider} style={BOTTOM_LINE} /> : null}
    </View>
  );
}

function useUrlField(tab: ToolbarTab, windowId: string, onFocus: () => void) {
  const pageBar = usePageBarOf(tab.windowId, tab.id), developerMode = useDeveloperMode(tab.url) || !!pageBar;
  const showFullUrl = useSettings((s) => s.showFullUrl);
  const insecure = usePage(tab.id, insecureLevel);
  const popover = usePages((p) => p.popover[tab.id] ?? null);
  const { hovered: pointerOver, hoverProps } = useHover();
  const hovered = pointerOver || popover === "siteControls";
  const buttonsShown = fieldButtonsShown(useSettings((s) => s.addressBarButtons), hovered);
  const openPanel = useStableHandler(() => {
    onFocus();
    openBarFromAddress(windowId, tab.url);
  });
  const toggleSiteControls = useStableHandler(() => {
    onFocus();
    togglePopover(tab.id, "siteControls");
  });
  return { insecure, popover, hovered, buttonsShown, developerMode, pageBar, hoverProps, openPanel, toggleSiteControls, host: pageHostLabel(tab.url), trail: urlTrail(tab.url, tab.title, { hovered, showFullUrl }) };
}

const loadFillColor = (palette: ToolbarPalette, accent: string) =>
  palette.background && colorDistance(accent, palette.background) < FIELD_LOAD.accentApartFromBand ? palette.text : accent;

type UrlFieldProps = { tab: ToolbarTab; palette: ToolbarPalette; windowId: string; onFocus: () => void };

export const ToolbarUrlField = memo(function ToolbarUrlField({ tab, palette, windowId, inSplit, loadFill, onFocus, style, splitHint }: UrlFieldProps & { inSplit: boolean; loadFill: boolean; style: ViewStyle; splitHint: string | undefined }) {
  const theme = useTheme();
  const row = useToolbarRow();
  const field = useUrlField(tab, windowId, onFocus);
  const { insecure, hovered, buttonsShown, popover, toggleSiteControls } = field;
  const openSplit = useStableHandler(() => openSplitPane(windowId, { anchorTabId: tab.id }));
  const glass = useGlass();

  return (
    <View {...field.hoverProps} style={[style, { flexDirection: "row", alignItems: "center", height: row.field, borderRadius: row.fieldRadius, backgroundColor: hovered && !glass ? palette.pill : undefined }]}>
      {glass ? (
        <GlassFill state={hovered ? "lit" : "rest"} radius={row.fieldRadius} dark={palette.background ? palette.text.startsWith(ink.white) : undefined} />
      ) : null}
      {loadFill && <FieldLoadFill tabId={tab.id} color={loadFillColor(palette, theme.accent)} height={row.field} radius={row.fieldRadius} />}
      {insecure && (
        <Pressable onPress={toggleSiteControls} style={{ paddingLeft: LOCK.left }} tooltip="Connection is not secure">
          {drawnSymbol({
            name: "lock.open.trianglebadge.exclamationmark.fill",
            size: 12,
            color: insecure === "certificateError" ? theme.destructive : palette.secondary,
            style: { width: LOCK.width, height: row.field },
          })}
        </Pressable>
      )}
      <ContextMenuArea style={{ flex: 1 }} onContextMenu={() => void showUrlBarMenu(tab)}>
        <Pressable onPress={field.openPanel} style={{ flex: 1, height: row.field, justifyContent: "center", paddingLeft: insecure ? LOCK.gap : urlTextLeft(false) }}>
          {field.developerMode ? (
            <Text numberOfLines={1} ellipsizeMode="middle" color={palette.text} ardiaCentersCapitals style={monoFace()}>
              {withoutUserInfo(field.pageBar?.url ?? tab.url)}
            </Text>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text numberOfLines={1} ellipsizeMode="head" weight="medium" color={palette.text} ardiaCentersCapitals style={HOST_FULL}>
                {field.host}
              </Text>
              {field.trail ? (
                <Text numberOfLines={1} color={palette.secondary} ardiaCentersCapitals style={SHRINK}>
                  {field.trail}
                </Text>
              ) : null}
            </View>
          )}
        </Pressable>
      </ContextMenuArea>
      <FieldButtons tab={tab} palette={palette} onFocus={onFocus} popover={popover} toggleSiteControls={toggleSiteControls} quiet={!buttonsShown}>
        {buttonsShown && (
          <>
            <PageButton tab={tab} palette={palette} windowId={windowId} />
            {!inSplit && splitViewAvailable && (
              <Button variant="icon" toolbar
                palette={palette}
                icon="rectangle.split.2x1"
                look="field"
                onPress={openSplit}
                tooltip={withShortcut("Open Split View", splitHint)}
              />
            )}
            <Button variant="icon" toolbar palette={palette} icon="slider.horizontal.3" look="field" onPress={toggleSiteControls} active={popover === "siteControls"} tooltip="Site Controls" />
          </>
        )}
        {field.pageBar ? <PageBarFieldButtons windowId={windowId} tabId={tab.id} match={field.pageBar} palette={palette} onFocus={onFocus} /> : field.developerMode && <DeveloperToolsButtons tabId={tab.id} palette={palette} look="field" onFocus={onFocus} />}
      </FieldButtons>
    </View>
  );
});

export const SidebarUrlField = memo(function SidebarUrlField({ tab, palette, windowId, onFocus, height, accessory }: UrlFieldProps & { height: number; accessory: ReactNode }) {
  const theme = useTheme();
  const field = useUrlField(tab, windowId, onFocus);
  const { insecure, hovered, popover, toggleSiteControls } = field;
  const extensionsHeld = useFieldExtensionsHeld(windowId);
  const shown = sidebarFieldButtons({ mode: useSettings((s) => s.addressBarButtons), hovered, insecure: !!insecure, extensionsHeld });
  const openSiteControls = useStableHandler(() => {
    if (popover !== "siteControls") noteSiteControls("sidebarField");
    toggleSiteControls();
  });

  return (
    <View {...field.hoverProps} style={{ flexDirection: "row", alignItems: "center", height, borderRadius: SIDEBAR_FIELD.radius }}>
      <SidebarFieldFill hovered={hovered} />
      <FieldLoadFill tabId={tab.id} color={loadFillColor(palette, theme.accent)} height={height} radius={SIDEBAR_FIELD.radius} />
      {shown.leading && (
        <FieldSiteButton
          icon={insecure ? "lock.open.trianglebadge.exclamationmark.fill" : "slider.horizontal.3"}
          color={insecure === "certificateError" ? theme.destructive : undefined}
          tooltip={insecure ? "Connection is not secure" : "Site Controls"}
          active={popover === "siteControls"}
          palette={palette}
          onPress={openSiteControls}
        />
      )}
      <ContextMenuArea style={{ flex: 1 }} onContextMenu={() => void showUrlBarMenu(tab)}>
        <Pressable onPress={field.openPanel} style={{ flex: 1, height, justifyContent: "center", paddingLeft: shown.leading ? SIDEBAR_TEXT_GAP : SIDEBAR_TEXT_ALONE }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text numberOfLines={1} ellipsizeMode="head" weight="medium" color={palette.text} ardiaCentersCapitals style={SHRINK}>
              {field.host}
            </Text>
            <FadeLabel text={field.trail} fontSize={sidebarFont.body.fontSize} color={palette.secondary} fadeWidth={14} style={{ flex: 1, height: sidebarPoints(18), marginLeft: -space.xxs }} />
          </View>
        </Pressable>
      </ContextMenuArea>
      <ToolbarRowContext.Provider value={TOOLBAR_ROWS.regular}>
        <FieldButtons tab={tab} palette={palette} onFocus={onFocus} popover={popover} toggleSiteControls={openSiteControls} accessory={shown.extensions ? accessory : null} quiet={!shown.page}>
          {shown.page && <PageButton tab={tab} palette={palette} windowId={windowId} />}
          {shown.siteControls && <Button variant="icon" toolbar palette={palette} icon="slider.horizontal.3" look="field" onPress={openSiteControls} active={popover === "siteControls"} tooltip="Site Controls" />}
        </FieldButtons>
      </ToolbarRowContext.Provider>
    </View>
  );
});

const HOST_FULL = { flexShrink: 0, maxWidth: "100%" } as const;
const SHRINK = { flexShrink: 1 } as const;

type PageButtonProps = { tab: ToolbarTab; palette: ToolbarPalette; windowId: string };

function PageButton(props: PageButtonProps) {
  return useBookmarksShown() ? <BookmarkButton {...props} /> : <CopyUrlButton {...props} />;
}

function CopyUrlButton({ tab, palette }: PageButtonProps) {
  const copyHint = useShortcutHint("copyUrl");
  return <Button variant="icon" toolbar palette={palette} icon="link" look="field" onPress={() => void copyPageUrl(tab.id)} tooltip={withShortcut("Copy URL", copyHint)} />;
}

function BookmarkButton({ tab, palette, windowId }: PageButtonProps) {
  const bookmarkHint = useShortcutHint("bookmarkPage");
  const bookmarked = useIsBookmarked(tab.url);
  return (
    <Button variant="icon" toolbar palette={palette} icon={bookmarked ? "bookmark.fill" : "bookmark"} look="field" onPress={() => toggleBookmarkOfTab(windowId, tab.id)} tooltip={bookmarked ? "Remove Bookmark" : withShortcut("Bookmark This Page", bookmarkHint)} />
  );
}

function FieldButtons({
  tab,
  palette,
  onFocus,
  popover,
  toggleSiteControls,
  accessory,
  quiet = false,
  children,
}: {
  tab: ToolbarTab;
  palette: ToolbarPalette;
  onFocus: () => void;
  popover: string | null;
  toggleSiteControls: () => void;
  accessory?: ReactNode;
  quiet?: boolean;
  children: ReactNode;
}) {
  const popups = usePage(tab.id, (p) => p.popups.length);
  const capture = usePage(tab.id, (p) => p.mediaAccess);
  const reader = useReaderButtonShown(tab.id, quiet);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingRight: space.xs }}>
      {children}
      {capture && <CaptureIndicator camera={capture.camera} microphone={capture.microphone} screen={capture.screen} onPress={toggleSiteControls} />}
      {reader && <ReaderButton tabId={tab.id} palette={palette} onFocus={onFocus} quiet={quiet} />}
      <TranslateButton tabId={tab.id} palette={palette} onFocus={onFocus} quiet={quiet} />
      <ZoomIndicator tabId={tab.id} zoom={tab.zoom} palette={palette} onFocus={onFocus} quiet={quiet} />
      {popups > 0 && (
        <Button variant="icon" toolbar
          palette={palette}
          icon="macwindow.badge.plus"
          look="field"
          onPress={() => {
            onFocus();
            togglePopover(tab.id, "popups");
          }}
          active={popover === "popups"}
          tooltip="Pop-ups blocked on this page"
        />
      )}
      {accessory}
    </View>
  );
}

function CaptureIndicator({ camera, microphone, screen, onPress }: { camera: boolean; microphone: boolean; screen: boolean; onPress: () => void }) {
  const theme = useTheme();
  const icon = screen ? "rectangle.inset.filled.on.rectangle" : camera ? "video.fill" : "mic.fill";
  const what = [camera && "camera", microphone && "microphone", screen && "screen"].filter(Boolean).join(" and ");
  return <Button variant="icon" icon={icon} look="field" color={theme.destructive} onPress={onPress} tooltip={`This page is using your ${what}`} />;
}

