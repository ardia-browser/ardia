import { Button, ListRow, NativeFormContext, space, Symbol, Text, VisualEffect, WindowDragRegion } from "../ui";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useTheme } from "../ui/theme";
import { useProfile } from "../../state/browser/hooks";
import { usePluginTitle } from "../../state/plugins/hooks";
import { trackSettingsSection } from "../../state/telemetry/track";
import { preparePane, usePaneLoaded } from "../../state/settings/paneData";
import { clearSettingsReveal, flashSetting, useSettingsSearch } from "../../state/settings/searchState";
import { anchorView } from "./anchors";
import { findSetting, PANES, paneTitle } from "./settingsIndex";
import { SettingsPaneContext } from "./Form";
import { PageToolbar } from "../pages/PageLayout";
import { SettingsSearchField, SettingsSearchResults } from "./SettingsSearch";
import { AdvancedPane } from "./panes/Advanced";
import { AppearancePane } from "./panes/Appearance";
import { AutomationsPane } from "./panes/Automations";
import { GeneralPane } from "./panes/General";
import { PluginsPane } from "./panes/Plugins";
import { ProfilesPane } from "./panes/Profiles";
import { ShortcutsPane } from "./panes/Shortcuts";
import { TabsPane } from "./panes/Tabs";
import { useSettingsSheet } from "../../state/settings/sheet";
import { SettingsConsentSheet } from "../plugins/SettingsConsentSheet";
import { goToSettingsPane, SETTINGS_WINDOW_ID, settingsBack, settingsForward, useSettingsNav, type SettingsPane, type SettingsPlace } from "../../state/settings/settingsWindows";
import { closeProfileIconPickerIn } from "../../state/profiles/iconPicker";
import { ProfileIconPicker } from "../profiles/ProfileIconPicker";
import { settingsProfileFor } from "../../state/extensions/store";
import { useSettingsColors } from "./useSettingsColors";
import { paneTile, paneTints, settingsLayout } from "./tokens";
import { pageToolbar } from "../pages/tokens";
import { WINDOW_CHROME, WINDOW_CONTROLS, windowControlsWidth } from "../../lib/windowChrome";
import { markCaptionRegions } from "../../state/windows/controls";
import { LIGHTS_CENTER } from "../../state/windows/dockMotion";
import { setTrafficLightsCenter } from "../../state/windows/nativeWindow";
import { WindowControls } from "../window/WindowControls";
import { noteSettingsScroll } from "../../state/settings/growingRows";

const SIDEBAR = settingsLayout.sidebarWidth;
const TOOLBAR = pageToolbar.window.height;
const SIDEBAR_TOP = WINDOW_CHROME.leadingWidth ? TOOLBAR : space.ml;
const TITLE_LEFT = SIDEBAR + 96;
const CONTROLS_ROOM = WINDOW_CONTROLS.edge + windowControlsWidth() + WINDOW_CONTROLS.gap;
const HOLD_CAP_MS = 250;
const REVEAL_MARGIN = 16;

const shownKey = (s: SettingsPlace) => `${s.pane}:${s.profileId ?? ""}:${s.detail ?? ""}`;
const pageKey = (s: SettingsPlace) => (s.pane === "profiles" && !s.detail ? "profiles::" : shownKey(s));

function useShownPane(): SettingsPlace | null {
  const nav = useSettingsNav();
  const target = { pane: nav.pane, profileId: nav.profileId, detail: nav.detail };
  const key = shownKey(target);
  const loaded = usePaneLoaded(nav.pane, nav.profileId);
  const [expired, setExpired] = useState<string | null>(null);
  const [last, setLast] = useState<SettingsPlace | null>(null);
  const ready = loaded || expired === key;
  useEffect(() => {
    if (ready) return setLast(target);
    void preparePane(target.pane, target.profileId);
    const timer = setTimeout(() => setExpired(key), HOLD_CAP_MS);
    return () => clearTimeout(timer);
  }, [key, ready]);
  return ready ? target : last;
}

function usePrefetchAllPanes(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      for (const p of PANES) void preparePane(p.id, null);
    }, 0);
    return () => clearTimeout(timer);
  }, [enabled]);
}

export function SettingsWindow() {
  const look = useSettingsColors();
  const nav = useSettingsNav();
  const shown = useShownPane();
  usePrefetchAllPanes(!!shown);
  const profileName = useProfile(shown?.profileId, (p) => p?.name);
  const pluginTitle = usePluginTitle(shown?.pane === "plugins" ? shown.detail : null);
  const title = shown ? (shown.pane === "profiles" && profileName ? profileName : shown.pane === "plugins" && pluginTitle ? pluginTitle : paneTitle(shown.pane)) : "";
  const sheet = useSettingsSheet((s) => s.sheet);
  useEffect(() => trackSettingsSection(nav.pane), [nav.pane]);
  useEffect(() => markCaptionRegions(SETTINGS_WINDOW_ID, [[TITLE_LEFT, 0, CONTROLS_ROOM, TOOLBAR]]), []);
  useEffect(() => void setTrafficLightsCenter(SETTINGS_WINDOW_ID, [LIGHTS_CENTER[0], TOOLBAR / 2]), []);
  const scroller = useRef<ScrollView>(null);
  const key = shown ? shownKey(shown) : "";
  const page = shown ? pageKey(shown) : "";
  useLayoutEffect(() => scroller.current?.scrollTo({ y: 0, animated: false }), [page]);
  useEffect(() => closeProfileIconPickerIn(SETTINGS_WINDOW_ID), [key]);
  const content = useRef<View>(null);
  const scrollTop = useRef(0);
  const viewport = useRef(0);
  const query = useSettingsSearch((s) => s.query);
  const reveal = useSettingsSearch((s) => s.reveal);
  const revealPane = reveal ? (findSetting(reveal.id)?.pane ?? null) : null;
  const switched = useRef(key);
  useEffect(() => {
    if (!reveal) return;
    if (nav.pane !== revealPane) return void clearSettingsReveal();
    if (shown?.pane !== revealPane) return;
    const animated = switched.current === key;
    const frame = requestAnimationFrame(() => {
      const target = anchorView(reveal.id);
      const container = content.current;
      if (!target || !container) return flashSetting("");
      target.measureLayout(
        container,
        (_x, y, _w, h) => {
          const top = animated ? scrollTop.current : 0;
          const inView = y >= top + REVEAL_MARGIN && y + h <= top + viewport.current - REVEAL_MARGIN;
          if (!inView) scroller.current?.scrollTo({ y: Math.max(0, y - viewport.current / 3), animated });
          flashSetting(reveal.id);
        },
        () => flashSetting(reveal.id),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal, key]);
  useEffect(() => {
    switched.current = key;
  }, [key]);

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: look.windowFill }}>
      <View style={{ width: SIDEBAR }}>
        <VisualEffect material="sidebar" blendingMode="behindWindow" style={StyleSheet.absoluteFill} />
        <WindowDragRegion style={{ height: SIDEBAR_TOP }} />
        <SettingsSearchField />
        {query.trim() ? (
          <SettingsSearchResults query={query} />
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={SIDEBAR_LIST}>
            {PANES.map((p) => (
              <SidebarItem key={p.id} title={p.title} icon={p.icon} tint={paneTints[p.tint]} selected={nav.pane === p.id} onPress={() => goToSettingsPane(p.id, settingsProfileFor(p.id, nav))} />
            ))}
          </ScrollView>
        )}
      </View>
      <View style={{ width: StyleSheet.hairlineWidth * 2, backgroundColor: look.sidebarDivider }} />
      <View style={{ flex: 1 }}>
        <PageToolbar size="window" drag>
          <Button variant="icon" toolbar icon="chevron.left" size="l" disabled={!nav.back.length} onPress={() => settingsBack()} tooltip="Back" />
          <Button variant="icon" toolbar icon="chevron.right" size="l" disabled={!nav.forward.length} onPress={() => settingsForward()} tooltip="Forward" />
          <Text size="title" weight="semibold" style={WINDOW_TITLE}>
            {title}
          </Text>
        </PageToolbar>
        <ScrollView
          ref={scroller}
          scrollEventThrottle={16}
          onScroll={({ nativeEvent: { contentOffset, layoutMeasurement, contentSize } }) => {
            scrollTop.current = contentOffset.y;
            noteSettingsScroll(contentOffset.y, layoutMeasurement.height, contentSize.height);
          }}
          onLayout={(e) => void (viewport.current = e.nativeEvent.layout.height)}
          contentContainerStyle={PANE_SCROLL}>
          <View key={page} ref={content} collapsable={false} style={PANE_COLUMN}>
            {shown ? (
              <NativeFormContext.Provider value>
                <SettingsPaneContext.Provider value={shown.pane}>
                  <Pane {...shown} />
                </SettingsPaneContext.Provider>
              </NativeFormContext.Provider>
            ) : null}
          </View>
        </ScrollView>
      </View>
      <ProfileIconPicker windowId={SETTINGS_WINDOW_ID} />
      {sheet}
      <SettingsConsentSheet />
      <WindowControls windowId={SETTINGS_WINDOW_ID} centerY={TOOLBAR / 2} size={WINDOW_CONTROLS.regular} />
    </View>
  );
}

const SIDEBAR_LIST = { paddingHorizontal: space.ml, paddingBottom: space.l, gap: space.xs } as const;
const WINDOW_TITLE = { marginLeft: space.m } as const;
const PANE_SCROLL = { alignItems: "center", paddingBottom: settingsLayout.paneBottom } as const;
const PANE_COLUMN = { width: "100%", maxWidth: settingsLayout.paneMaxWidth, paddingHorizontal: space.xxxl } as const;
const PANE_VIEWS: Record<SettingsPane, (place: SettingsPlace) => ReactNode> = {
  general: (place) => <GeneralPane {...place} />,
  profiles: (place) => <ProfilesPane {...place} />,
  tabs: (place) => <TabsPane {...place} />,
  appearance: (place) => <AppearancePane {...place} />,
  automations: (place) => <AutomationsPane {...place} />,
  plugins: (place) => <PluginsPane {...place} />,
  shortcuts: (place) => <ShortcutsPane {...place} />,
  advanced: (place) => <AdvancedPane {...place} />,
};

function Pane(place: SettingsPlace): ReactNode {
  return PANE_VIEWS[place.pane](place);
}

function SidebarItem({ title, icon, tint, selected, onPress }: { title: string; icon: string; tint: string; selected: boolean; onPress: () => void }) {
  return (
    <ListRow height={SIDEBAR_ITEM_HEIGHT} selected={selected} selectedTone="accent" onPress={onPress}>
      <View style={[PANE_TILE, { backgroundColor: tint }]}>
        <Symbol name={icon} size={paneTile.symbol} weight="semibold" color={paneTints.ink} style={PANE_TILE_SYMBOL} />
      </View>
      <Text tone={selected ? "onAccent" : "textPrimary"}>{title}</Text>
    </ListRow>
  );
}

const SIDEBAR_ITEM_HEIGHT = 30;
const PANE_TILE = { width: paneTile.size, height: paneTile.size, borderRadius: paneTile.radius, alignItems: "center", justifyContent: "center" } as const;
const PANE_TILE_SYMBOL = { width: paneTile.size, height: paneTile.size } as const;

