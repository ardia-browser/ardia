import { memo, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { DockSelection, radius, Surface, Text, withAlpha } from "../ui";
import { hex, layout, useTheme } from "../ui/theme";
import { useTileTheme, type TileTheme } from "../../state/favicons/tileTheme";
import { useTab } from "../../state/browser/hooks";
import { GlassFill, useGlass } from "../ui/Glass";
import { SLIDE } from "../tabstrip/tokens";
import { TabBadges } from "../media/TabBadges";
import { TabIcon } from "./TabIcon";
import { sidebarTokens, TILE_GLOW, TILE_RIM, useSidebarTokens } from "./tokens";
import { useSelectedTopApp } from "../../state/app/theme";
import type { Settings } from "../../state/settings/settings";
import { useQuietRows } from "./rowLook";
import { useIsSleeping } from "../../state/tabs/sleepingTabs";
import { tileLetterOf } from "../../lib/tileLetter";
import { useTabState } from "../../state/tabs/tabStateWatch";
import { isClosedTopApp } from "../../state/sidebar/rowState";

const SELECTION_STROKE = 3;
const GLASS_RING = 2;

type FaceState = { width: number; active: boolean; selected: boolean; hovered: boolean; pressed: boolean };
type TopAppLook = Settings["selectedTopApp"];

export const TileFace = memo(function TileFace({ tabId, badge, ...state }: FaceState & { tabId: string; badge?: ReactNode }) {
  return useQuietRows() ? <LetterTile tabId={tabId} badge={badge} {...state} /> : <RichTileFace tabId={tabId} badge={badge} {...state} />;
});

const LETTER_SCALE = 12 / 34;
const ASLEEP_LETTER = 0.45;

function LetterTile({ tabId, badge, width, active, selected, hovered, pressed }: FaceState & { tabId: string; badge?: ReactNode }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const url = useTab(tabId, (t) => t?.url ?? "");
  const title = useTab(tabId, (t) => t?.customTitle ?? t?.title ?? "");
  const asleep = useIsSleeping(tabId);
  const height = layout.pinnedHeight;
  const fill = active ? tokens.quietTileLive : pressed ? tokens.quietPressed : hovered || selected ? tokens.quietWash : tokens.quietTile;
  return (
    <View
      accessibilityLabel={title}
      style={{
        width,
        height,
        borderRadius: radius.pinned,
        backgroundColor: fill,
        borderWidth: selected && !active ? 1 : 0,
        borderColor: tokens.dragBorder,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View>
        <Text size="small" weight="medium" style={{ fontSize: Math.round(Math.min(width, height) * LETTER_SCALE * 2) / 2, opacity: asleep && !active ? ASLEEP_LETTER : 1 }} color={hex(withAlpha(theme.textTab, active ? tokens.quietActiveText : tokens.quietText))}>
          {tileLetterOf(url, title)}
        </Text>
        <TabBadges tabId={tabId} />
      </View>
      {badge}
    </View>
  );
}

const RichTileFace = memo(function RichTileFace({ tabId, badge, ...state }: FaceState & { tabId: string; badge?: ReactNode }) {
  const theme = useTheme();
  const tab = useTab(tabId);
  const tileTheme = useTileTheme(tab?.url ?? "", tab?.favicon, tab?.customIcon, tab?.profileId ?? "");
  const glass = useGlass();
  const topApp = useSelectedTopApp();
  const closed = useTabState(tabId, (s) => isClosedTopApp(s, tabId));
  if (!tab) return null;
  const { width, active } = state;
  const icon = (
    <View>
      <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} />
      <TabBadges tabId={tabId} />
    </View>
  );
  if (glass)
    return (
      <GlassTile {...state} tileTheme={tileTheme} topApp={topApp} bare={closed}>
        {icon}
        {badge}
      </GlassTile>
    );
  if (active && tileTheme)
    return (
      <DockSelection
        image={tileTheme.image}
        emoji={tileTheme.emoji}
        theme={tileTheme.theme.kind}
        fill={tileTheme.theme.kind === "template" ? tileTheme.theme.fill : undefined}
        stroke={tileTheme.theme.kind === "template" ? tileTheme.theme.stroke : undefined}
        cornerRadius={radius.pinned}
        strokeWidth={topApp === "fill" ? 0 : SELECTION_STROKE}
        outline={topApp === "outline"}
        dark={theme.dark}
        style={{ width, height: layout.pinnedHeight, alignItems: "center", justifyContent: "center" }}
      >
        {tileTheme.theme.kind === "template" && topApp !== "outline" ? (
          <View>
            <View style={{ width: 16, height: 16 }} />
            <TabBadges tabId={tabId} />
          </View>
        ) : (
          icon
        )}
        {badge}
      </DockSelection>
    );
  if (active && topApp !== "ring")
    return (
      <PlainSelectedTile width={width} outline={topApp === "outline"}>
        {icon}
        {badge}
      </PlainSelectedTile>
    );
  if (active)
    return (
      <Surface
        fill={hex(theme.pinnedSelectedRim)}
        cornerRadius={radius.pinned}
        shadowColor={sidebarTokens(theme).tileGlow}
        shadowOpacity={theme.dark ? TILE_GLOW.opacity.dark : TILE_GLOW.opacity.light}
        shadowRadius={TILE_GLOW.radius}
        shadowOffset={TILE_GLOW.offset}
        style={{ width, height: layout.pinnedHeight, padding: TILE_RIM }}
      >
        <View
          style={{
            flex: 1,
            borderRadius: radius.pinned - TILE_RIM,
            backgroundColor: theme.pinnedSelectedFill,
            borderTopWidth: 1,
            borderColor: theme.pinnedSelectedOutline,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {icon}
        </View>
        {badge}
      </Surface>
    );
  return (
    <RestingTile {...state} bare={closed}>
      {icon}
      {badge}
    </RestingTile>
  );
});

function PlainSelectedTile({ width, outline, children }: { width: number; outline: boolean; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width,
        height: layout.pinnedHeight,
        borderRadius: radius.pinned,
        borderWidth: outline ? SELECTION_STROKE : 0,
        borderColor: theme.pinnedSelectedFill,
        backgroundColor: outline ? undefined : theme.pinnedSelectedFill,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </View>
  );
}

export function RestingTile({ width, selected, hovered, pressed, bare = false, children }: Omit<FaceState, "active"> & { bare?: boolean; children: ReactNode }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const quiet = useQuietRows();
  const glass = useGlass();
  if (quiet)
    return (
      <View
        style={{
          width,
          height: layout.pinnedHeight,
          borderRadius: radius.pinned,
          borderWidth: selected ? 1 : 0,
          borderColor: tokens.dragBorder,
          backgroundColor: pressed ? tokens.quietPressed : hovered || selected ? tokens.quietWash : tokens.quietTile,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children}
      </View>
    );
  if (glass)
    return (
      <GlassTile width={width} active={false} selected={selected} hovered={hovered} pressed={pressed} tileTheme={null} bare={bare}>
        {children}
      </GlassTile>
    );
  if (bare && !selected && !hovered && !pressed) return <View style={{ width, height: layout.pinnedHeight, alignItems: "center", justifyContent: "center" }}>{children}</View>;
  return (
    <View
      style={{
        width,
        height: layout.pinnedHeight,
        borderRadius: radius.pinned,
        borderWidth: selected ? 1 : StyleSheet.hairlineWidth,
        borderColor: selected ? tokens.dragBorder : theme.pinnedRestingStroke,
        backgroundColor: pressed ? theme.tabPressed : hovered || selected ? theme.tabHover : theme.pinnedResting,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </View>
  );
}

function GlassTile({ width, active, selected, hovered, pressed, tileTheme, topApp = "ring", bare = false, children }: FaceState & { tileTheme: TileTheme | null; topApp?: TopAppLook; bare?: boolean; children: ReactNode }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  if (bare && !active && !selected && !hovered && !pressed) return <View style={{ width, height: layout.pinnedHeight, alignItems: "center", justifyContent: "center" }}>{children}</View>;
  return (
    <View style={{ width, height: layout.pinnedHeight }}>
      <GlassFill radius={radius.pinned} state={pressed ? "pressed" : active && topApp !== "outline" ? "active" : hovered || selected ? "lit" : "rest"}>
        {active ? (
          <DockSelection
            image={tileTheme?.image}
            emoji={tileTheme?.emoji}
            theme={tileTheme?.theme.kind}
            fill={tileTheme?.theme.kind === "template" ? tileTheme.theme.fill : undefined}
            cornerRadius={radius.pinned}
            strokeWidth={topApp === "fill" ? 0 : GLASS_RING}
            outline={topApp === "outline"}
            dark={theme.dark}
            glass
            colorRing
            style={StyleSheet.absoluteFill}
          />
        ) : selected ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius.pinned, borderWidth: 1, borderColor: tokens.dragBorder }]} />
        ) : null}
        {children}
      </GlassFill>
    </View>
  );
}

const RING_OUTSET = 3;

export function FolderDropRing({ on }: { on: boolean }) {
  const theme = useTheme();
  const shown = useMemo(() => new Animated.Value(on ? 1 : 0), []);
  useEffect(() => {
    const spring = Animated.spring(shown, { toValue: on ? 1 : 0, ...SLIDE });
    spring.start();
    return () => spring.stop();
  }, [on, shown]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: -RING_OUTSET,
        right: -RING_OUTSET,
        top: -RING_OUTSET,
        bottom: -RING_OUTSET,
        borderRadius: radius.pinned + RING_OUTSET,
        borderWidth: 2,
        borderColor: theme.accent,
        backgroundColor: sidebarTokens(theme).folderDropFill,
        opacity: shown,
        transform: [{ scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }],
      }}
    />
  );
}

export function useSlotPosition(x: number, y: number, width: number, sliding: boolean, dragging: boolean) {
  const position = useMemo(() => new Animated.ValueXY({ x, y }), []);
  const placedWidth = useRef(width);
  useLayoutEffect(() => {
    if (dragging) return;
    const resized = placedWidth.current !== width;
    placedWidth.current = width;
    if (sliding && !resized) Animated.spring(position, { toValue: { x, y }, ...SLIDE }).start();
    else position.setValue({ x, y });
  }, [x, y, width, sliding, dragging, position]);
  useEffect(() => () => position.stopAnimation(), [position]);
  return position;
}
