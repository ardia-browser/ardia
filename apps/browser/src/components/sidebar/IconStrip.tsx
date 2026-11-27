import { createContext, memo, useContext, useMemo, useRef, type ReactNode } from "react";
import { PanResponder, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ActivitySpinner, clippedContinuousCorners, ink, radius, Symbol, useHover, WindowDragRegion, withAlpha } from "../ui";
import { useTheme } from "../ui/theme";
import { useGroup, useIsActiveTab, useProfile, useTab, useTabLive, useWindowProfileId } from "../../state/browser/hooks";
import { useAnyShownTab, useIconStripCodes } from "../../state/sidebar/hooks";
import { useSidebarRowsVersion } from "../../state/sidebar/rowGeometry";
import { useMuteState } from "../../state/tabs/hooks";
import { stripItemOf, type StripBar, type StripItem } from "../../state/sidebar/iconStrip";
import { isIncognitoProfile } from "../../state/browser/model";
import { openProfileMenu } from "../../state/browser/actions";
import { newTab } from "../../state/tabs/actions";
import { toggleNewTabBar } from "../../state/omnibox/newTabBar";
import { TileUnread } from "../unread/UnreadBadge";
import { ProfileBadge } from "../profiles/ProfileIcons";
import { ProfileSwipeArea } from "../window/ProfileSwipe";
import { INCOGNITO_ICON } from "../ntp/IncognitoHeading";
import { TabPressArea } from "./TabPressArea";
import { TabIcon } from "./TabIcon";
import { FolderOrIcon } from "./AnimatedFolder";
import { groupTint } from "./tokens";
import { RestingTile } from "./TileFace";
import { dragGesture } from "./dragGesture";
import { ICON_STRIP, STRIP_DIVIDER_HEIGHT, stripInset, stripLayout } from "./iconStripGeometry";
import { useRowCenters } from "./useRowCenters";
import type { ConsentToken } from "../../state/telemetry/client";

export type StripActions = {
  pressed: () => ConsentToken | null;
  open: (item: StripItem, consent: ConsentToken | null) => void;
  drag: (key: string) => { press: () => void; begin: (x: number, y: number) => void; move: (x: number, y: number) => void; end: (commit: boolean) => void };
};

const SQUARE = ICON_STRIP.square;
const RowSquare = createContext<number>(SQUARE);
const ICON = 16;
const BAR = { width: 3, left: 2 } as const;
const BADGE = 11;
const DIVIDER_INSET = 5;

type RowAlignment = { offset: number; paused: boolean; layoutKey: string };

const keyOf = (code: string) => code.split("\u0001")[1] ?? code;
const ALIGNED = new Set(["tab", "split", "group", "live"]);

export function IconStrip({ windowId, right, top, bottom, actions, align }: { windowId: string; right: boolean; top: number; bottom: number; actions: StripActions; align: RowAlignment }) {
  const profileId = useWindowProfileId();
  const codes = useIconStripCodes(windowId, profileId);
  const entries = useMemo(() => codes.map((code) => ({ code, key: keyOf(code), kind: code.slice(0, code.indexOf("\u0001")) })), [codes]);
  const aligned = useMemo(() => entries.filter((e) => ALIGNED.has(e.kind)).map((e) => e.key), [entries]);
  const rowsVersion = useSidebarRowsVersion(windowId);
  const centers = useRowCenters(windowId, aligned, align.offset, align.paused, `${align.layoutKey}:${rowsVersion}`);
  const layout = useMemo(() => stripLayout(entries.map((e) => ({ key: ALIGNED.has(e.kind) ? e.key : `${e.kind}:${e.key}`, divider: e.kind === "divider", aligned: ALIGNED.has(e.kind) })), centers, top), [entries, centers, top]);
  return (
    <View style={StyleSheet.absoluteFill}>
      <WindowDragRegion style={StyleSheet.absoluteFill} />
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ height: layout.end + SQUARE + ICON_STRIP.gap * 2 }}>
        {entries.map((e, i) => (
          <View key={`${e.kind}:${e.key}`} style={{ position: "absolute", left: 0, right: 0, top: layout.slots[i]!.top }}>
            <RowSquare.Provider value={ALIGNED.has(e.kind) ? layout.square : SQUARE}>
              <StripEntry code={e.code} windowId={windowId} right={right} actions={actions} joinAbove={layout.slots[i]!.joinAbove} />
            </RowSquare.Provider>
          </View>
        ))}
        <View style={{ position: "absolute", left: 0, right: 0, top: layout.end }}>
          <NewTabSquare windowId={windowId} actions={actions} />
        </View>
      </ScrollView>
      <View style={{ paddingBottom: bottom }}>
        <StripDivider />
        <View style={{ height: SQUARE, paddingHorizontal: stripInset }}>
          <SpaceSquare windowId={windowId} profileId={profileId} actions={actions} />
        </View>
      </View>
      <ProfileSwipeArea surface="strip" style={StyleSheet.absoluteFill} />
    </View>
  );
}

const StripEntry = memo(function StripEntry({ code, windowId, right, actions, joinAbove }: { code: string; windowId: string; right: boolean; actions: StripActions; joinAbove: number }) {
  const item = useMemo(() => stripItemOf(code), [code]);
  if (item.kind === "divider") return <StripDivider />;
  const bar = "bar" in item ? item.bar : null;
  return (
    <StripCell bar={bar} right={right} joinAbove={joinAbove}>
      {item.kind === "tile" || item.kind === "tab" ? (
        <TabSquare windowId={windowId} tabId={item.tabId} itemKey={item.key} tile={item.kind === "tile"} actions={actions} />
      ) : item.kind === "split" ? (
        <TabSquare windowId={windowId} tabId={item.tabIds[0]!} itemKey={item.key} tile={false} split={item.tabIds} actions={actions} />
      ) : (
        <OpenSquare item={item} actions={actions} />
      )}
    </StripCell>
  );
});

function StripCell({ bar, right, joinAbove, children }: { bar: StripBar | null; right: boolean; joinAbove: number; children: ReactNode }) {
  const size = useContext(RowSquare);
  return (
    <View style={{ height: size, paddingHorizontal: (ICON_STRIP.width - size) / 2 }}>
      {bar ? <GroupBar bar={bar} right={right} joinAbove={joinAbove} /> : null}
      {children}
    </View>
  );
}

function GroupBar({ bar, right, joinAbove }: { bar: StripBar; right: boolean; joinAbove: number }) {
  const theme = useTheme();
  const tint = groupTint(bar.color) ?? theme.textTertiary;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        [right ? "right" : "left"]: BAR.left,
        width: BAR.width,
        top: bar.first ? 3 : -joinAbove,
        bottom: bar.last ? 3 : 0,
        borderTopLeftRadius: bar.first ? BAR.width : 0,
        borderTopRightRadius: bar.first ? BAR.width : 0,
        borderBottomLeftRadius: bar.last ? BAR.width : 0,
        borderBottomRightRadius: bar.last ? BAR.width : 0,
        backgroundColor: tint,
      }}
    />
  );
}

function StripDivider() {
  const theme = useTheme();
  return (
    <View style={{ height: STRIP_DIVIDER_HEIGHT, justifyContent: "center" }}>
      <View style={{ height: StyleSheet.hairlineWidth, marginHorizontal: stripInset + DIVIDER_INSET, backgroundColor: theme.pinnedDivider }} />
    </View>
  );
}

function useSquareFill(state: { selected: boolean; hovered: boolean; pressed: boolean; tile: boolean }) {
  const theme = useTheme();
  if (state.pressed) return theme.tabPressed;
  if (state.selected) return theme.tabSelected;
  if (state.hovered) return theme.tabHover;
  return ink.clear;
}

function Square({ fill, stroke, children }: { fill: string; stroke?: string; children: ReactNode }) {
  const size = useContext(RowSquare);
  return (
    <View
      style={{
        width: size,
        height: size,
        ...clippedContinuousCorners(radius.chrome),
        backgroundColor: fill,
        borderWidth: stroke ? StyleSheet.hairlineWidth : 0,
        borderColor: stroke,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </View>
  );
}

function useStripDrag(key: string, actions: StripActions) {
  return useMemo(() => {
    const target = actions.drag(key);
    return PanResponder.create({ ...dragGesture(true, target), onStartShouldSetPanResponderCapture: () => (target.press(), false) }).panHandlers;
  }, [key, actions]);
}

const TabSquare = memo(function TabSquare({ windowId, tabId, itemKey, tile, split, actions }: { windowId: string; tabId: string; itemKey: string; tile: boolean; split?: string[]; actions: StripActions }) {
  const theme = useTheme();
  const tab = useTab(tabId);
  const active = useIsActiveTab(tabId);
  const otherActive = useAnyShownTab(split);
  const loading = useTabLive(tabId, (l) => l.isLoading);
  const playing = useTabLive(tabId, (l) => l.playingAudio);
  const mute = useMuteState(tabId);
  const { hovered, hoverProps } = useHover();
  const handlers = useStripDrag(itemKey, actions);
  if (!tab) return null;
  return (
    <View {...handlers} {...hoverProps}>
      <TabPressArea windowId={windowId} tab={tab} selected={active || otherActive} tooltip={tab.title || undefined} onSwitch={actions.pressed}>
        {({ pressed }) => (
          <SquareFor selected={active || otherActive} hovered={hovered} pressed={pressed} tile={tile}>
            {loading && !tile ? <ActivitySpinner style={{ width: 14, height: 14 }} /> : <TabIcon tabId={tabId} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} size={ICON} />}
            {split && split.length > 1 ? <Badge corner="bottom" color={theme.textSecondary} name="rectangle.split.2x1" /> : null}
            {playing || mute ? <Badge corner="top" color={theme.textSecondary} name={mute ? "speaker.slash.fill" : "speaker.wave.2.fill"} /> : null}
            <TileUnread tabId={tabId} />
          </SquareFor>
        )}
      </TabPressArea>
    </View>
  );
});

function SquareFor({ selected, hovered, pressed, tile, children }: { selected: boolean; hovered: boolean; pressed: boolean; tile: boolean; children: ReactNode }) {
  const fill = useSquareFill({ selected, hovered, pressed, tile: false });
  if (tile)
    return (
      <RestingTile width={SQUARE} height={SQUARE} selected={selected} hovered={hovered} pressed={pressed}>
        {children}
      </RestingTile>
    );
  return <Square fill={fill}>{children}</Square>;
}

function Badge({ corner, color, name }: { corner: "top" | "bottom"; color: string; name: string }) {
  const theme = useTheme();
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        right: 1,
        [corner]: 1,
        width: BADGE,
        height: BADGE,
        borderRadius: BADGE / 2,
        backgroundColor: withAlpha(theme.windowTint[0] ?? theme.textPrimary, 0.92),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Symbol name={name} size={7} color={color} style={{ width: 9, height: 9 }} />
    </View>
  );
}

function OpenSquare({ item, actions }: { item: Extract<StripItem, { kind: "group" | "tileFolder" | "live" }>; actions: StripActions }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const group = useGroup(item.kind === "group" ? item.groupId : null, (g) => g);
  const handlers = useStripDrag(item.key, actions);
  const pressedWith = useRef<ConsentToken | null>(null);
  const title = item.kind === "group" ? group?.name || "Folder" : item.kind === "tileFolder" ? "Folder" : "Live Folder";
  return (
    <View {...handlers} {...hoverProps}>
      <Pressable
        tooltip={title}
        onPressIn={() => {
          pressedWith.current = actions.pressed();
        }}
        onPress={() => actions.open(item, pressedWith.current)}
      >
        {({ pressed }) => (
          <SquareFor selected={false} hovered={hovered} pressed={pressed} tile={item.kind === "tileFolder"}>
            {item.kind === "live" ? <Symbol name="dot.radiowaves.left.and.right" size={13} color={theme.textSecondary} style={{ width: ICON, height: ICON }} /> : <FolderOrIcon icon={group?.icon ?? null} open={item.kind === "group" && item.open} color={item.kind === "group" ? item.color : null} />}
          </SquareFor>
        )}
      </Pressable>
    </View>
  );
}

function NewTabSquare({ windowId, actions }: { windowId: string; actions: StripActions }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View style={{ height: SQUARE, paddingHorizontal: stripInset }} {...hoverProps}>
      <Pressable
        tooltip="New Tab"
        onPressIn={() => {
          actions.pressed();
          if (!toggleNewTabBar(windowId)) newTab(windowId, { newTabCommand: true });
        }}
      >
        {({ pressed }) => (
          <SquareFor selected={false} hovered={hovered} pressed={pressed} tile={false}>
            <Symbol name="plus" size={13} weight="semibold" color={theme.textSecondary} style={{ width: ICON, height: ICON }} />
          </SquareFor>
        )}
      </Pressable>
    </View>
  );
}

function SpaceSquare({ windowId, profileId, actions }: { windowId: string; profileId: string; actions: StripActions }) {
  const theme = useTheme();
  const profile = useProfile(profileId, (p) => p);
  const { hovered, hoverProps } = useHover();
  const incognito = isIncognitoProfile(profileId);
  return (
    <View {...hoverProps}>
      <Pressable
        tooltip={incognito ? "Incognito" : "Switch between profiles"}
        disabled={incognito}
        onPressIn={() => {
          actions.pressed();
          void openProfileMenu(windowId);
        }}
      >
        {({ pressed }) => (
          <SquareFor selected={false} hovered={hovered} pressed={pressed} tile={false}>
            {incognito || !profile ? <Symbol name={INCOGNITO_ICON} size={13} weight="semibold" color={theme.textPrimary} style={{ width: ICON, height: ICON }} /> : <ProfileBadge profile={profile} size={20} />}
          </SquareFor>
        )}
      </Pressable>
    </View>
  );
}
