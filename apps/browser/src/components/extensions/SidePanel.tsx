import { Box, Button, Divider, Text, WebView, type WebViewHandle } from "../ui";
import { useEffect, useRef, useState } from "react";
import { Animated, Image, StyleSheet, View } from "react-native";
import { useTheme } from "../ui/theme";
import { useCardFrame } from "../window/cardFrame";
import { useSettings, useWindowId } from "../../state/browser/hooks";
import { currentSettings } from "../../state/browser/current";
import { updateSettings } from "../../state/settings/actions";
import { DEFAULT_SETTINGS } from "../../state/settings/settings";
import { openFromPage, pageProfileId } from "../../state/tabs/openFromPage";
import { space } from "../ui/tokens";
import { EXTENSION_PAGE_BACKGROUND, SIDE_PANEL_HEADER_PAD_RIGHT } from "./tokens";
import { closePanelCard, closeSidePanelOnTab, dropSidePanelCard, findExtension, panelKey, showExtensionMenu, shownReadyTab, takeSidePanelFocus, useExtensions, type SidePanel } from "../../state/extensions/actions";
import { curve, duration } from "../ui/motion";
import { GLYPH } from "../toolbar/tokens";
import { useResizeDrag } from "../sidebar/useResizeDrag";

const MIN_WIDTH = 320;
const MAX_WIDTH = 600;
const HEADER = 40;

const NO_CARDS: SidePanel[] = [];

export function ExtensionSidePanel() {
  const windowId = useWindowId();
  const entry = useExtensions((e) => e.sidePanels[windowId]);
  const cards = useExtensions((e) => e.sidePanelCards[windowId] ?? NO_CARDS);
  const panel = entry && !entry.hidden ? entry : undefined;
  const state = !entry ? "closed" : entry.hidden ? "hidden" : "shown";
  const savedWidth = useSettings((st) => st.extensionSidePanelWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const appear = useRef(new Animated.Value(0)).current;
  const gap = useCardFrame().splitGap;
  const lastShown = useRef<SidePanel | undefined>(panel);
  const lastSeen = useRef<{ state: string; tab?: string }>({ state: "closed" });
  const [exit, setExit] = useState<{ state: string; card: SidePanel | null; instant: boolean }>({ state, card: null, instant: false });
  let { card: leaving, instant } = exit;
  if (exit.state !== state) {
    const tab = shownReadyTab(windowId);
    const before = lastSeen.current;
    instant = before.state !== "closed" && state !== "closed" && !!tab && tab !== before.tab;
    leaving = !panel && !instant && before.state === "shown" ? (lastShown.current ?? null) : null;
    setExit({ state, card: leaving, instant });
  }

  useEffect(() => {
    Animated.timing(appear, { toValue: panel ? 1 : 0, duration: instant ? 0 : duration.base, easing: curve.enter, useNativeDriver: false }).start(({ finished }) => {
      if (finished) setExit((now) => (now.state === state ? { ...now, card: null } : now));
    });
  }, [state]);
  useEffect(() => {
    lastSeen.current = { state, tab: shownReadyTab(windowId) };
    if (panel) lastShown.current = panel;
  });

  const width = dragWidth ?? savedWidth;
  const resizeHandlers = useResizeDrag({
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    direction: -1,
    saved: () => currentSettings().extensionSidePanelWidth,
    onLive: setDragWidth,
    onCommit: (w) => updateSettings({ extensionSidePanelWidth: w }),
  });

  const fading = leaving && !cards.some((card) => panelKey(card) === panelKey(leaving)) ? leaving : null;
  const rendered = fading ? [...cards, fading] : cards;
  if (!rendered.length) return null;
  const room = width + gap;
  return (
    <Animated.View style={{ width: appear.interpolate({ inputRange: [0, 1], outputRange: [0, room] }), overflow: "hidden" }}>
      <Animated.View style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: width, opacity: appear }}>
        {rendered.map((p) => {
          const current = panel ? panelKey(p) === panelKey(panel) : p === fading;
          return (
            <PanelCard
              key={panelKey(p)}
              windowId={windowId}
              panel={p}
              current={current}
              onWindowClose={() => p !== fading && closePanelCard(windowId, p)}
              onHiddenCrash={() => dropSidePanelCard(windowId, p)}
            />
          );
        })}
        <View
          {...resizeHandlers}
          onDoubleClick={() => updateSettings({ extensionSidePanelWidth: DEFAULT_SETTINGS.extensionSidePanelWidth })}
          style={{ position: "absolute", top: 0, bottom: 0, left: -3, width: 7, cursor: "col-resize" }}
        />
      </Animated.View>
    </Animated.View>
  );
}

function PanelCard({ windowId, panel, current, onWindowClose, onHiddenCrash }: { windowId: string; panel: SidePanel; current: boolean; onWindowClose: () => void; onHiddenCrash: () => void }) {
  const { extensionId, profile, pageProfile, url, opened } = panel;
  const theme = useTheme();
  const cardRadius = useCardFrame().radius;
  const web = useRef<WebViewHandle>(null);
  const [loaded, setLoaded] = useState(false);
  const lookingUp = useExtensions((e) => !!e.sidePanelLookups[windowId]);
  useEffect(() => {
    if (current && loaded && takeSidePanelFocus(windowId, panel)) void web.current?.focus();
  }, [current, loaded, opened, lookingUp]);
  const ext = useExtensions((e) => e.lists[profile]?.find((x) => x.id === extensionId));
  const title = ext?.actionTitle || ext?.name || "Extension";
  const icon = ext?.actionIcon || ext?.icon;
  return (
    <View
      pointerEvents={current ? "auto" : "none"}
      style={{ ...StyleSheet.absoluteFillObject, opacity: current ? 1 : 0, borderRadius: cardRadius, overflow: "hidden", backgroundColor: theme.card }}
    >
      <Box row gap="m" style={HEADER_ROW}>
        {icon ? <Image source={{ uri: icon }} style={{ width: 16, height: 16 }} /> : null}
        <Text numberOfLines={1} weight="medium" style={FLEX}>
          {title}
        </Text>
        <Button variant="icon"
          icon="ellipsis"
          glyph={GLYPH}
          tooltip="More"
          onPress={() => {
            const found = findExtension(profile, extensionId);
            if (found) void showExtensionMenu(windowId, found);
          }}
        />
        <Button variant="icon" icon="xmark" glyph={GLYPH} weight="medium" tooltip="Close Side Panel" onPress={() => closeSidePanelOnTab(windowId)} />
      </Box>
      <Divider />
      <View style={PAGE}>
        <WebView
          ref={web}
          style={StyleSheet.absoluteFill}
          url={url}
          profile={pageProfile}
          standalone
          visible={current}
          warm={!current}
          extensionHost="sidePanel"
          pageBackgroundColor={EXTENSION_PAGE_BACKGROUND}
          onNavigationChange={({ isLoading }) => {
            if (!isLoading) setLoaded(true);
          }}
          onWindowClose={onWindowClose}
          onCrashed={current ? undefined : onHiddenCrash}
          onOpenWindow={(request) => openFromPage(request, { windowId, profileId: pageProfileId(windowId, pageProfile) })}
        />
      </View>
    </View>
  );
}

const FLEX = { flex: 1 } as const;
const HEADER_ROW = { height: HEADER, alignItems: "center", paddingLeft: space.l, paddingRight: SIDE_PANEL_HEADER_PAD_RIGHT } as const;
const PAGE = { flex: 1, backgroundColor: EXTENSION_PAGE_BACKGROUND } as const;
