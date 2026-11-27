import { createContext, memo, useContext, useMemo, useRef, type ReactNode } from "react";
import { PanResponder, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ActivitySpinner, clippedContinuousCorners, ContextMenuArea, ink, radius, Symbol, useHover, WindowDragRegion, withAlpha } from "../ui";
import { useTheme } from "../ui/theme";
import { useGroup, useIsActiveTab, useProfile, useTab, useTabLive, useWindowProfileId } from "../../state/browser/hooks";
import { useAnyShownTab, useIconStripCodes } from "../../state/sidebar/hooks";
import { useSidebarRowsVersion } from "../../state/sidebar/rowGeometry";
import { useMuteState } from "../../state/tabs/hooks";
import { STRIP_LIST_DIVIDER, stripItemOf, type StripItem } from "../../state/sidebar/iconStrip";
import type { GroupColor } from "../../state/browser/types";
import { isIncognitoProfile } from "../../state/browser/model";
import { openProfileMenu } from "../../state/browser/actions";
import { openGroupMenu } from "../../state/sidebar/menus";
import { newTab } from "../../state/tabs/actions";
import { toggleNewTabBar } from "../../state/omnibox/newTabBar";
import { TileUnread } from "../unread/UnreadBadge";
import { ProfileBadge } from "../profiles/ProfileIcons";
import { useProfileDotsShown } from "../profiles/ProfileDots";
import { ProfileSwipeArea } from "../window/ProfileSwipe";
import { INCOGNITO_ICON } from "../ntp/IncognitoHeading";
import { TabPressArea } from "./TabPressArea";
import { TabIcon } from "./TabIcon";
import { FolderOrIcon, useFolderInk } from "./AnimatedFolder";
import { RestingTile } from "./TileFace";
import { dragGesture } from "./dragGesture";
import { ICON_STRIP, STRIP_DIVIDER_HEIGHT, stripBarSpans, stripInset, stripLayout, stripMeasureKey, type BarSpan } from "./iconStripGeometry";
import { useNewTabAtTop } from "../../state/sidebar/chrome";
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
  const switcherShown = useProfileDotsShown();
  const codes = useIconStripCodes(windowId, profileId);
  const entries = useMemo(() => codes.map((code) => ({ code, key: keyOf(code), kind: code.slice(0, code.indexOf("\u0001")) })), [codes]);
  const aligned = useMemo(() => entries.filter((e) => ALIGNED.has(e.kind)).map((e) => e.key), [entries]);
  const rowsVersion = useSidebarRowsVersion(windowId);
  const newTabAtTop = useNewTabAtTop();
  const listDivider = entries.some((e) => e.key === STRIP_LIST_DIVIDER) ? STRIP_LIST_DIVIDER : null;
  const centers = useRowCenters(windowId, aligned, align.offset, align.paused, stripMeasureKey(align.layoutKey, rowsVersion, newTabAtTop, codes), listDivider);
  const layout = useMemo(() => stripLayout(entries.map((e) => ({ key: ALIGNED.has(e.kind) || e.kind === "divider" ? e.key : `${e.kind}:${e.key}`, divider: e.kind === "divider", aligned: ALIGNED.has(e.kind) })), centers, top), [entries, centers, top]);
  const spans = useMemo(
    () => stripBarSpans(entries.map((e) => { const item = stripItemOf(e.code); return "bar" in item ? item.bar : null; }), layout.slots, (i) => (ALIGNED.has(entries[i]!.kind) ? layout.square : SQUARE)),
    [entries, layout],
  );
  return (
    <View style={StyleSheet.absoluteFill}>
      <WindowDragRegion style={StyleSheet.absoluteFill} />
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ height: layout.end + SQUARE + ICON_STRIP.gap * 2 }}>
        {spans.map((span) => (
          <GroupBar key={`${span.top}`} span={span} right={right} />
        ))}
        {entries.map((e, i) => (
          <View key={`${e.kind}:${e.key}`} style={{ position: "absolute", left: 0, right: 0, top: layout.slots[i]!.top }}>
            <RowSquare.Provider value={ALIGNED.has(e.kind) ? layout.square : SQUARE}>
              <StripEntry code={e.code} windowId={windowId} right={right} actions={actions} />
            </RowSquare.Provider>
          </View>
        ))}
        <View style={{ position: "absolute", left: 0, right: 0, top: layout.end }}>
          <NewTabSquare windowId={windowId} actions={actions} />
        </View>
      </ScrollView>
      <View style={{ paddingBottom: bottom }}>
        {switcherShown ? (
          <>
            <StripDivider />
            <View style={{ height: SQUARE, paddingHorizontal: stripInset }}>
              <SpaceSquare windowId={windowId} profileId={profileId} actions={actions} />
            </View>
          </>
        ) : null}
      </View>
      <ProfileSwipeArea surface="strip" style={StyleSheet.absoluteFill} />
    </View>
  );
}

const StripEntry = memo(function StripEntry({ code, windowId, right, actions }: { code: string; windowId: string; right: boolean; actions: StripActions }) {
  const item = useMemo(() => stripItemOf(code), [code]);
  if (item.kind === "divider") return <StripDivider />;
  return (
    <StripCell>
      {item.kind === "tile" || item.kind === "tab" ? (
        <TabSquare windowId={windowId} tabId={item.tabId} itemKey={item.key} tile={item.kind === "tile"} actions={actions} />
      ) : item.kind === "split" ? (
        <TabSquare windowId={windowId} tabId={item.tabIds[0]!} itemKey={item.key} tile={false} split={item.tabIds} actions={actions} />
      ) : (
        <OpenSquare item={item} windowId={windowId} actions={actions} />
      )}
    </StripCell>
  );
});

function StripCell({ children }: { children: ReactNode }) {
  const size = useContext(RowSquare);
  return <View style={{ height: size, paddingHorizontal: (ICON_STRIP.width - size) / 2 }}>{children}</View>;
}

function GroupBar({ span, right }: { span: BarSpan; right: boolean }) {
  const tint = useFolderInk(span.color as GroupColor | null).stroke;
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", [right ? "right" : "left"]: BAR.left, width: BAR.width, top: span.top, height: span.bottom - span.top, borderRadius: BAR.width / 2, backgroundColor: tint }}
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

function OpenSquare({ item, windowId, actions }: { item: Extract<StripItem, { kind: "group" | "tileFolder" | "live" }>; windowId: string; actions: StripActions }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const group = useGroup(item.kind === "group" ? item.groupId : null, (g) => g);
  const handlers = useStripDrag(item.key, actions);
  const pressedWith = useRef<ConsentToken | null>(null);
  const title = item.kind === "group" ? group?.name || "Folder" : item.kind === "tileFolder" ? "Folder" : "Live Folder";
  const head = item.kind === "group" && item.head;
  return (
    <View {...handlers} {...hoverProps}>
      <ContextMenuArea onContextMenu={() => void (item.kind === "group" && openGroupMenu(windowId, item.groupId))}>
        <Pressable
          tooltip={title}
          onPressIn={() => {
            pressedWith.current = actions.pressed();
          }}
          onPress={() => actions.open(item, pressedWith.current)}
        >
          {({ pressed }) => (
            <SquareFor selected={false} hovered={hovered} pressed={pressed} tile={item.kind === "tileFolder"}>
              {head ? null : item.kind === "live" ? (
                <Symbol name="dot.radiowaves.left.and.right" size={13} color={theme.textSecondary} style={{ width: ICON, height: ICON }} />
              ) : (
                <FolderOrIcon icon={group?.icon ?? null} open={item.kind === "group" && item.open} color={item.kind === "group" ? item.color : null} />
              )}
            </SquareFor>
          )}
        </Pressable>
      </ContextMenuArea>
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
