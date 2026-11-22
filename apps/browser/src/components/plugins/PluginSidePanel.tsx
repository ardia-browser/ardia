import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useWindowId } from "../../state/browser/hooks";
import { closePluginSidePanel, ensurePluginActivated } from "../../state/plugins/actions";
import { usePluginManifest, usePluginRetainedSidePanels, usePluginSidePanel, usePluginWindowEligible } from "../../state/plugins/hooks";
import type { SidePanel } from "../../state/plugins/surfaces";
import { Box, Button, curve, Divider, duration, space, Symbol, Text, useTheme } from "../ui";
import { useCardFrame } from "../window/cardFrame";
import { useResizeDrag } from "../sidebar/useResizeDrag";
import { GLYPH } from "../toolbar/tokens";
import { PluginFileView } from "./PluginFileView";
import { PluginSurface } from "./PluginSurface";
import { pluginFileUrl } from "./surfaceNodes";
import { SIDE_PANEL, SURFACE } from "./tokens";
import { t } from "../../lib/uiLanguage";


const panelKeyOf = (panel: SidePanel) => `${panel.plugin}:${panel.panelId}:${panel.generation}`;

export function PluginSidePanel({ hidden = false }: { hidden?: boolean }) {
  const windowId = useWindowId();
  const eligible = usePluginWindowEligible(windowId);
  const entry = usePluginSidePanel(windowId);
  const retained = usePluginRetainedSidePanels(windowId);
  const panel = entry && !entry.hidden ? entry : null;
  const shownKey = panel ? panelKeyOf(panel) : null;
  const gap = useCardFrame().splitGap;
  const appear = useRef(new Animated.Value(panel ? 1 : 0)).current;
  const lastShown = useRef<SidePanel | null>(panel);
  const [exit, setExit] = useState<{ key: string | null; card: SidePanel | null }>({ key: shownKey, card: null });
  let leaving = exit.card;
  if (exit.key !== shownKey) {
    leaving = panel ? null : lastShown.current;
    setExit({ key: shownKey, card: leaving });
  }
  const [savedWidth, setWidth] = useState<number>(SIDE_PANEL.initial);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? savedWidth;
  const latestWidth = useRef(savedWidth);
  latestWidth.current = savedWidth;
  useEffect(() => {
    const animation = Animated.timing(appear, { toValue: panel ? 1 : 0, duration: duration.base, easing: curve.enter, useNativeDriver: false });
    animation.start(({ finished }) => {
      if (finished && !panel) setExit((now) => (now.key === null ? { ...now, card: null } : now));
    });
    return () => animation.stop();
  }, [!!panel]);
  useEffect(() => {
    if (panel) lastShown.current = panel;
  });
  const resize = useResizeDrag({
    min: SIDE_PANEL.min,
    max: SIDE_PANEL.max,
    direction: -1,
    saved: () => latestWidth.current,
    onLive: setDragWidth,
    onCommit: (next) => setWidth(next),
  });
  if (!eligible) return null;
  const rendered = [...retained];
  for (const extra of [panel, leaving]) {
    if (extra && !rendered.some((card) => panelKeyOf(card) === panelKeyOf(extra))) rendered.push(extra);
  }
  if (!rendered.length) return null;
  const currentKey = shownKey ?? (leaving ? panelKeyOf(leaving) : null);
  return (
    <Animated.View style={{ width: appear.interpolate({ inputRange: [0, 1], outputRange: [0, width + gap] }), overflow: "hidden", display: hidden ? "none" : "flex" }}>
      <Animated.View style={{ position: "absolute", top: 0, bottom: 0, right: 0, width, opacity: appear }}>
        {rendered.map((card) => {
          const key = panelKeyOf(card);
          return <PanelCard key={key} windowId={windowId} panel={card} current={key === currentKey} live={key === shownKey} />;
        })}
        <View {...resize} onDoubleClick={() => setWidth(SIDE_PANEL.initial)} style={HANDLE} />
      </Animated.View>
    </Animated.View>
  );
}

function PanelCard({ windowId, panel, current, live }: { windowId: string; panel: SidePanel; current: boolean; live: boolean }) {
  const theme = useTheme();
  const cardRadius = useCardFrame().radius;
  const manifest = usePluginManifest(panel.plugin);
  const spec = manifest?.contributes.panels.find((p) => p.id === panel.panelId);
  const title = spec?.title ?? manifest?.title ?? panel.plugin;
  const icon = spec?.icon || manifest?.icon || "puzzlepiece";
  const url = spec?.file ? pluginFileUrl(panel.plugin, spec.file) : null;
  const activatesHost = !!url && !!spec && manifest?.main != null;
  useEffect(() => {
    if (activatesHost && spec) void ensurePluginActivated(panel.plugin, `onPanel:${spec.id}`).catch(() => {});
  }, [activatesHost, panel.plugin, spec?.id]);
  return (
    <View pointerEvents={live ? "auto" : "none"} style={{ ...StyleSheet.absoluteFillObject, opacity: current ? 1 : 0, borderRadius: cardRadius, overflow: "hidden", backgroundColor: theme.card }}>
      <Box row gap="m" style={HEADER}>
        <Symbol name={icon} size={SURFACE.icon} color={theme.icon} style={ICON} />
        <Text numberOfLines={1} weight="medium" style={FLEX}>
          {title}
        </Text>
        <Button variant="icon" icon="xmark" glyph={GLYPH} weight="medium" tooltip={t(`Close Side Panel`)} onPress={() => closePluginSidePanel(windowId, panel.plugin)} />
      </Box>
      <Divider />
      <View style={FLEX}>
        {!spec ? (
          <Box pad="l">
            <Text tone="textSecondary">This panel isn't available any more.</Text>
          </Box>
        ) : url ? (
          <PluginFileView plugin={panel.plugin} url={url} />
        ) : (
          <View style={SURFACE_PAD}>
            <PluginSurface plugin={panel.plugin} surfaceId={spec.view ?? spec.id} viewId={spec.view ?? spec.id} kind="panel" windowId={windowId} context={{ panelId: panel.panelId }} />
          </View>
        )}
      </View>
    </View>
  );
}

const FLEX = { flex: 1 } as const;
const HEADER = { height: SIDE_PANEL.header, alignItems: "center", paddingLeft: space.l, paddingRight: space.s } as const;
const ICON = { width: SURFACE.iconBox, height: SURFACE.iconBox } as const;
const SURFACE_PAD = { flex: 1, padding: space.s } as const;
const HANDLE = { position: "absolute", top: 0, bottom: 0, left: SIDE_PANEL.handleOffset, width: SIDE_PANEL.handle, cursor: "col-resize" } as const;
