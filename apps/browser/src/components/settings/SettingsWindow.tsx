import { Button, ListRow, NativeFormContext, space, Symbol, Text, VisualEffect, WindowDragRegion } from "../ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useProfile } from "../../state/browser/hooks";
import { usePluginTitle } from "../../state/plugins/hooks";
import { trackSettingsSection } from "../../state/telemetry/track";
import { preparePane, usePaneLoaded } from "../../state/settings/paneData";
import { dropReveal, revealTargetShown, revealWanted, runReveal, settingsSearchHost, useSettingsSearch } from "../../state/settings/searchState";
import { anchorView } from "./anchors";
import { findSetting, resolveSettingId, PANES, paneTitle } from "./settingsIndex";
import { SettingsPaneContext, UnshownSettingsProvider } from "./Form";
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
import { claimSettingsOpenAt, forgetSettingsScroll, goToSettingsPane, SETTINGS_WINDOW_ID, settingsScrollFor, settingsBack, settingsForward, settingsPageKey, settingsPlaceKey, useSettingsNav, type SettingsPane, type SettingsPlace } from "../../state/settings/settingsWindows";
import { closeProfileIconPickerIn } from "../../state/profiles/iconPicker";
import { ProfileIconPicker } from "../profiles/ProfileIconPicker";
import { showCreateProfileSheets } from "../profiles/CreateProfile";
import { settingsProfileFor } from "../../state/extensions/store";
import { useSettingsColors } from "./useSettingsColors";
import { paneTile, paneTints, settingsLayout } from "./tokens";
import { pageToolbar } from "../pages/tokens";
import { WINDOW_CHROME, WINDOW_CONTROLS, windowControlsWidth } from "../../lib/windowChrome";
import { markCaptionRegions } from "../../state/windows/controls";
import { LIGHTS_CENTER } from "../../state/windows/dockMotion";
import { setTrafficLightsCenter } from "../../state/windows/nativeWindow";
import { WindowControls } from "../window/WindowControls";
import { LeadingWindowControls } from "../window/LeadingWindowControls";
import { useWindowChrome } from "../../state/windows/windowButtons";
import { noteSettingsScroll } from "../../state/settings/growingRows";
import { revealScrollTarget, settingsLayoutKey, settingsScroller, type ScrollMove } from "../../state/settings/paneScroll";
import { noteSettingsScrollRestore } from "../../state/telemetry/usage";
import { consentToken } from "../../state/telemetry/choice";

const SIDEBAR = settingsLayout.sidebarWidth;
const TOOLBAR = pageToolbar.window.height;
const sidebarTop = () => (WINDOW_CHROME.leadingWidth ? TOOLBAR : space.ml);
const TITLE_LEFT = SIDEBAR + 96;
const CONTROLS_ROOM = WINDOW_CONTROLS.edge + windowControlsWidth() + WINDOW_CONTROLS.gap;
const HOLD_CAP_MS = 250;
const PREFETCH_DELAY_MS = 150;

let layoutGenerations = 0;

type ShownPane = SettingsPlace & { visit: number };

function useShownPane(openedAt: number | null): ShownPane | null {
  const nav = useSettingsNav();
  const target = { pane: nav.pane, profileId: nav.profileId, detail: nav.detail, visit: nav.visit };
  const key = settingsPlaceKey(target);
  const loaded = usePaneLoaded(nav.pane, nav.profileId);
  const [expired, setExpired] = useState<string | null>(null);
  const [last, setLast] = useState<ShownPane | null>(null);
  const ready = loaded || expired === key;
  useEffect(() => {
    if (ready) return setLast(target);
    void preparePane(target.pane, target.profileId);
    const since = last ? null : openedAt;
    const wait = since ? Math.max(0, HOLD_CAP_MS - (Date.now() - since)) : HOLD_CAP_MS;
    const timer = setTimeout(() => setExpired(key), wait);
    return () => clearTimeout(timer);
  }, [key, nav.visit, ready]);
  return ready ? target : last;
}

function usePrefetchAllPanes(shown: SettingsPane | null) {
  useEffect(() => {
    if (!shown) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        for (const p of PANES) if (p.id !== shown) void preparePane(p.id, null);
      }, PREFETCH_DELAY_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, [!!shown]);
}

function PaneScrollView({
  layout,
  page,
  shown,
  visit,
  scroller,
  content,
  viewport,
  scrollMemory,
  move,
}: {
  layout: string;
  page: string;
  shown: ShownPane | null;
  visit: number;
  scroller: RefObject<ScrollView | null>;
  content: RefObject<View | null>;
  viewport: { current: number };
  scrollMemory: ReturnType<typeof settingsScroller>;
  move: (to: ScrollMove | null) => void;
}) {
  const generation = useMemo(() => ++layoutGenerations, [layout]);
  useLayoutEffect(() => {
    if (shown) move(scrollMemory.begin(visit, settingsScrollFor(visit), shown, consentToken(), generation));
  }, [visit]);

  return (
    <ScrollView
      ref={scroller}
      scrollEventThrottle={16}
      onScroll={({ nativeEvent: { contentOffset, layoutMeasurement, contentSize } }) => {
        scrollMemory.scrolled(contentOffset.y, contentSize.height - layoutMeasurement.height, contentSize.height, { layout, generation });
        noteSettingsScroll(contentOffset.y, layoutMeasurement.height, contentSize.height);
      }}
      onLayout={(e) => {
        viewport.current = e.nativeEvent.layout.height;
        scrollMemory.resized(e.nativeEvent.layout.height);
      }}
      contentContainerStyle={PANE_SCROLL}>
      <View
        key={page}
        ref={content}
        collapsable={false}
        style={PANE_COLUMN}>
        {shown ? (
          <NativeFormContext.Provider value>
            <SettingsPaneContext.Provider value={shown.pane}>
              <Pane {...shown} />
            </SettingsPaneContext.Provider>
          </NativeFormContext.Provider>
        ) : null}
        <View key={layout} onLayout={(e) => move(scrollMemory.laidOut(layout, e.nativeEvent.layout.y + settingsLayout.paneBottom, generation))} />
      </View>
    </ScrollView>
  );
}

export function SettingsWindow() {
  const look = useSettingsColors();
  useWindowChrome();
  const nav = useSettingsNav();
  const [openedAt] = useState(claimSettingsOpenAt);
  const shown = useShownPane(openedAt);
  usePrefetchAllPanes(shown?.pane ?? null);
  const profileName = useProfile(shown?.profileId, (p) => p?.name);
  const pluginTitle = usePluginTitle(shown?.pane === "plugins" ? shown.detail : null);
  const title = shown ? (shown.pane === "profiles" && profileName ? profileName : shown.pane === "plugins" && pluginTitle ? pluginTitle : paneTitle(shown.pane)) : "";
  const sheet = useSettingsSheet((s) => s.sheet);
  const trackedOpen = useRef(false);
  useEffect(() => {
    if (!shown) return;
    const since = trackedOpen.current ? null : openedAt;
    trackedOpen.current = true;
    trackSettingsSection(shown.pane, since ? Date.now() - since : undefined);
  }, [shown?.pane]);
  useEffect(() => settingsSearchHost(), []);
  useEffect(showCreateProfileSheets, []);
  useEffect(() => markCaptionRegions(SETTINGS_WINDOW_ID, [[TITLE_LEFT, 0, CONTROLS_ROOM, TOOLBAR]]), []);
  useEffect(() => void setTrafficLightsCenter(SETTINGS_WINDOW_ID, [LIGHTS_CENTER[0], TOOLBAR / 2]), []);
  const scroller = useRef<ScrollView>(null);
  const key = shown ? settingsPlaceKey(shown) : "";
  const page = shown ? settingsPageKey(shown) : "";
  const visit = shown?.visit ?? 0;
  const layout = shown ? settingsLayoutKey(shown) : "";
  const [scrollMemory] = useState(() => settingsScroller(noteSettingsScrollRestore));
  const move = (to: ScrollMove | null) => {
    if (to) scroller.current?.scrollTo({ y: to.y, animated: false });
  };
  useEffect(() => forgetSettingsScroll, []);
  useEffect(() => closeProfileIconPickerIn(SETTINGS_WINDOW_ID), [key]);
  const content = useRef<View>(null);
  const viewport = useRef(0);
  const query = useSettingsSearch((s) => s.query);
  const reveal = useSettingsSearch((s) => s.reveal);
  const revealPane = reveal ? (findSetting(reveal.id)?.pane ?? null) : null;
  const switched = useRef(key);
  useEffect(() => {
    if (!reveal) return;
    if (!revealWanted(reveal, nav) || revealPane !== reveal.target.pane) return void dropReveal(reveal.token);
    if (!revealTargetShown(shown, reveal)) return;
    const animated = switched.current === key;
    const id = resolveSettingId(reveal.id);
    let stop = () => {};
    const locate = () => {
      const target = anchorView(id);
      const container = content.current;
      if (!target || !container) return null;
      return {
        measure: (found: (y: number, height: number) => void, failed: () => void) => target.measureLayout(container, (_x, y, _w, h) => found(y, h), failed),
        still: () => anchorView(id) === target && content.current === container,
      };
    };
    const frame = requestAnimationFrame(() => {
      stop = runReveal(reveal, id, locate, (y, h) => {
        const next = revealScrollTarget(y, h, scrollMemory.revealTop(), viewport.current);
        if (next !== null) {
          scrollMemory.moved();
          scroller.current?.scrollTo({ y: next, animated });
        }
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, [reveal, key]);
  useEffect(() => {
    switched.current = key;
  }, [key]);

  return (
    <UnshownSettingsProvider>
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: look.windowFill }}>
      <View style={{ width: SIDEBAR }}>
        <VisualEffect material="sidebar" blendingMode="behindWindow" style={StyleSheet.absoluteFill} />
        <WindowDragRegion style={{ height: sidebarTop() }} />
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
          <Text size="title" weight="semibold" ardiaCentersCapitals style={WINDOW_TITLE}>
            {title}
          </Text>
        </PageToolbar>
        <PaneScrollView
          layout={layout}
          page={page}
          shown={shown}
          visit={visit}
          scroller={scroller}
          content={content}
          viewport={viewport}
          scrollMemory={scrollMemory}
          move={move}
        />
      </View>
      <ProfileIconPicker windowId={SETTINGS_WINDOW_ID} />
      {sheet}
      <SettingsConsentSheet />
      <WindowControls windowId={SETTINGS_WINDOW_ID} centerY={TOOLBAR / 2} size={WINDOW_CONTROLS.regular} />
      <LeadingWindowControls windowId={SETTINGS_WINDOW_ID} size={WINDOW_CONTROLS.regular} />
    </View>
    </UnshownSettingsProvider>
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
      <Text tone={selected ? "onAccent" : "textPrimary"} ardiaCentersCapitals>{title}</Text>
    </ListRow>
  );
}

const SIDEBAR_ITEM_HEIGHT = 30;
const PANE_TILE = { width: paneTile.size, height: paneTile.size, borderRadius: paneTile.radius, alignItems: "center", justifyContent: "center" } as const;
const PANE_TILE_SYMBOL = { width: paneTile.size, height: paneTile.size } as const;
