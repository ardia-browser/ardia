import { memo, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { toggleMute } from "../../state/browser/actions";
import { useIsActiveTab, useSettings, useTab, useTabLive, useWindowId } from "../../state/browser/hooks";
import { useMuteState, useTabGroupColor } from "../../state/tabs/hooks";
import { muteTitle, type MuteState } from "../../state/tabs/mute";
import { firstStaying } from "../../state/drag/drops";
import { pressTabClose, useTabCloseControl } from "../../state/sidebar/closeControl";
import { currentMovingTabIds } from "../../state/tabs/topStrip";
import { TabBadges } from "../media/TabBadges";
import { TabIcon } from "../sidebar/TabIcon";
import { Button, FadeLabel, HoverFill, Symbol, useTooltip } from "../ui";
import { surfaceTheme, useTheme } from "../ui/theme";
import { ThemeOverride } from "../ui/ThemeOverride";
import { toolbarPalette, useEasedColor } from "../ui/toolbarColors";
import { font, ink, radius, withAlpha } from "../ui/tokens";
import { over } from "../../lib/color";
import type { GroupColor } from "../../state/browser/types";
import { groupTint, useSidebarTokens, type SidebarTokens } from "../sidebar/tokens";
import { GROUP_TRAY_ALPHA } from "./tokens";
import { DockContext, FloatingStrip } from "./context";
import { tabIn, tileHold } from "./dockCross";
import { FadeIn } from "./FadeIn";
import { dropAt, type GroupOut, type StripDrag } from "./model";
import { PinnedFace } from "./PinnedFace";
import { SelectedTab } from "./SelectedTab";
import { CELL_STEP, dragRange, leaveIndex, type DragGeometry } from "./stripGroups";
import { AUDIO_BADGE, CHIP_LABEL_GAP, CHIP_PAD, CLOSE_MIN_CHIP, FAVICON, GAP, ITEM_HEIGHT, ITEM_TOP, PINNED_CELL, tabRadius, TITLE_FADE_MAX, TITLE_FADE_MIN, TITLE_MIN_CHIP, TOP_STRIP_HEIGHT } from "./tokens";
import { useStripDrag } from "./useStripDrag";
import { StripScrollContext } from "./stripScroll";
import { useStripCardHover } from "./StripHoverCard";
import { useChipHover, useChipHovered, useOwnChipHover, type ChipHover } from "./reachableHover";
import { TabPressArea } from "../sidebar/TabPressArea";
import { tabTitle } from "../../state/browser/model";
import { rowAwayTitle } from "../../state/pins/organize";
import { AwayTitleLabel } from "../sidebar/AwayTitle";
import { useStruckTitle } from "../../state/sidebar/rowState";
import { SLEEPING_TITLE_OPACITY } from "../sidebar/tokens";
import { UnreadCount } from "../unread/UnreadBadge";
import { useTabUnread } from "../../state/tabs/unread";
import { titleWithoutUnread } from "../../lib/unread";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";
import { TOGGLE_MS, toggleEase } from "./stripToggle";
import { reduceMotion } from "../ui/reduceMotion";
import { t } from "../../lib/uiLanguage";


export const DraggableChip = memo(function DraggableChip({
  tabId,
  width,
  geometry: givenGeometry,
  from: givenFrom,
  group,
  tuck,
  out,
}: {
  tabId: string;
  width: number;
  geometry?: DragGeometry;
  from?: number;
  group: string | null;
  tuck?: () => void;
  out?: GroupOut;
}) {
  const active = useIsActiveTab(tabId);
  const windowId = useWindowId();
  const strip = useContext(DockContext);
  const scroll = useContext(StripScrollContext);
  const topLevel = !givenGeometry && !group;
  const geometryOf = () => givenGeometry ?? strip!.current.top;
  const fromOf = () => givenFrom ?? strip?.current.slotOf(tabId) ?? -1;
  const dockOf = () => (topLevel && fromOf() >= 0 ? (strip?.current.dock ?? null) : null);
  const member = group && out && out.slot >= 0 ? out : null;
  const stripEnd = member ? member.top.lefts.at(-1)! + member.top.slots.at(-1)!.width : 0;
  const drag = useStripDrag({
    tabId,
    ids: () => currentMovingTabIds(tabId),
    pinned: false,
    groupId: group,
    get geometry() {
      return geometryOf();
    },
    get from() {
      return fromOf();
    },
    width,
    gap: GAP,
    scroll,
    get range(): StripDrag["range"] {
      const dock = dockOf();
      if (dock) {
        const geometry = geometryOf();
        const from = fromOf();
        return (grab) => [Math.min(0, dock.left - geometry.lefts[from]! - grab + PINNED_CELL / 2), dragRange(geometry, from)[1]];
      }
      return member ? [member.top.lefts[0]! - member.left - width / 2, stripEnd - member.left - width / 2] : undefined;
    },
    get cross() {
      return dockOf() ? tabIn(() => strip?.current ?? null, fromOf(), width) : undefined;
    },
    drop: (dx, ids) => {
      if (!member) return false;
      const at = leaveIndex(member.top, member.slot, member.chip, member.expanded, member.left + dx, width);
      if (at === null) return false;
      dropAt(ids, { zone: "list", beforeId: firstStaying(member.top.slots.slice(at), ids) });
      return true;
    },
  });
  const hover = useChipHover();
  const card = useStripCardHover(windowId, tabId, drag.ref, hover);
  const dock = drag.crossed ? dockOf() : null;
  const drawn = useChipWidth(width, () => topLevel && !!strip?.current.animateWidths);
  return (
    <Animated.View ref={drag.ref} {...drag.panHandlers} {...card} mouseDownCanMoveWindow={false} style={{ ...drag.style, zIndex: drag.dragging ? 10 : active ? 1 : 0 }}>
      <Animated.View style={{ opacity: drag.crossed ? 0 : 1 }}>
        <TabChip tabId={tabId} width={width} drawn={drawn} tuck={tuck} dragged={drag.dragging} hover={hover} />
      </Animated.View>
      {dock && (
        <FadeIn
          style={{
            left: drag.grab - PINNED_CELL / 2,
            top: ITEM_TOP + 0.5,
            transform: [{ translateX: tileHold(drag.dx, dock.left + dock.ids.length * CELL_STEP - geometryOf().lefts[fromOf()]! - drag.grab + PINNED_CELL / 2) }],
          }}
        >
          <PinnedFace tabId={tabId} active={active} hovered={false} pressed={false} />
        </FadeIn>
      )}
    </Animated.View>
  );
});

export function useWebsiteBand(tabId: string) {
  const theme = useTheme();
  const extend = useSettings((s) => s.extendWebsiteColor && !s.minimalismMode);
  const url = useTab(tabId)?.url;
  const themeColor = useTabLive(tabId, (l) => l.themeColor);
  const palette = toolbarPalette(theme, extend && url ? themeColor : null);
  return { palette, band: useEasedColor(palette.background) };
}

export function useChipWidth(width: number, animate: () => boolean) {
  const value = useRef(new Animated.Value(width)).current;
  const shown = useRef(width);
  useLayoutEffect(() => {
    if (shown.current === width) return;
    shown.current = width;
    value.stopAnimation();
    if (animate() && !reduceMotion()) Animated.timing(value, { toValue: width, duration: TOGGLE_MS, easing: toggleEase, useNativeDriver: false }).start();
    else value.setValue(width);
  }, [width]);
  return value;
}

export const TabChip = memo(function TabChip({ tabId, width, drawn, tuck, dragged, hover }: { tabId: string; width: number; drawn?: Animated.Value; tuck?: () => void; dragged: boolean; hover?: ChipHover }) {
  const onTint = useTheme();
  const windowId = useWindowId();
  const tab = useTab(tabId);
  const active = useIsActiveTab(tabId);
  const theme = active ? surfaceTheme(onTint) : onTint;
  const floating = useContext(FloatingStrip);
  const playing = useTabLive(tabId, (l) => l.playingAudio);
  const mute = useMuteState(tabId);
  const { palette, band } = useWebsiteBand(tabId);
  const closeControl = useTabCloseControl(tabId);
  const ownHover = useOwnChipHover();
  const chipHover = hover ?? ownHover;
  const unread = useTabUnread(tabId);
  const struck = useStruckTitle(tabId);
  const groupColor = useTabGroupColor(tabId);
  const tokens = useSidebarTokens();
  if (!tab) return null;
  const title = tab.customTitle ? tabTitle(tab) : titleWithoutUnread(tabTitle(tab), unread);
  const away = rowAwayTitle(tab);
  const compact = !active && !tuck && width < TITLE_MIN_CHIP;
  const titleFade = Math.max(TITLE_FADE_MIN, Math.min(TITLE_FADE_MAX, (width - CHIP_PAD.left - FAVICON - CHIP_LABEL_GAP - CHIP_PAD.right) / 3));
  const closable = active || !!tuck || width >= CLOSE_MIN_CHIP;
  const onBand = active && !floating && !!palette.background;
  const ink = onBand ? palette.text : active ? theme.tabSelectedText : theme.textTab;
  const plate = active ? (onBand ? palette.background! : theme.card) : over(theme.tabHover, over(groupTray(groupColor, tokens), theme.windowTint[0]));
  return (
    <ThemeOverride theme={theme}>
      <Animated.View {...chipHover.hoverProps} style={{ width: drawn ?? width, height: TOP_STRIP_HEIGHT }}>
        {active && <SelectedTab width={drawn ?? width} band={band} opaque={dragged} />}
        {dragged && !active && (
          <View pointerEvents="none" style={{ position: "absolute", left: 0, width, top: ITEM_TOP, height: ITEM_HEIGHT, borderRadius: tabRadius(), backgroundColor: theme.windowTint[0] }} />
        )}
        <TabPressArea windowId={windowId} tab={tab} style={StyleSheet.absoluteFill} pressStyle={{ flex: 1 }}>
          {({ pressed }) => (
            <ChipRow
              hover={chipHover}
              dragged={dragged}
              quiet={active}
              pressed={pressed && !active}
              inset={compact ? (width - FAVICON) / 2 : undefined}
              plate={plate}
              action={closable &&
                <Button variant="icon"
                  icon={tuck ? "minus" : closeControl.icon}
                  size="xs"
                  weight="semibold"
                  color={onBand ? palette.icon : undefined}
                  onPress={tuck ?? (() => pressTabClose(tab.id))}
                  tooltip={tuck ? t(`Hide in Group`) : closeControl.tooltip}
                />
              }
              badge={<UnreadCount unread={unread} ink={ink} />}
            >
              <View pointerEvents="none">
                <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} color={active ? ink : undefined} />
                <TabBadges tabId={tab.id} />
                {compact && (playing || mute) ? <AudioBadge mute={mute} color={theme.textTab} plate={theme.windowTint[0]} /> : null}
              </View>
              {!compact && (playing || mute) && (
                <MuteToggle tabId={tab.id} mute={mute} color={onBand ? palette.icon : theme.textTab} />
              )}
              {compact ? null : away ? (
                <AwayTitleLabel away={away} color={ink} fontSize={font.small.fontSize} height={16} struck={struck} style={{ flex: 1, marginLeft: CHIP_LABEL_GAP }} />
              ) : (
                <FadeLabel text={title} fontSize={font.small.fontSize} fadeWidth={titleFade} color={ink} strikethrough={struck} style={{ flex: 1, height: 16, marginLeft: CHIP_LABEL_GAP, opacity: struck ? SLEEPING_TITLE_OPACITY : 1 }} />
              )}
            </ChipRow>
          )}
        </TabPressArea>
      </Animated.View>
    </ThemeOverride>
  );
});

function AudioBadge({ mute, color, plate }: { mute: MuteState; color: string; plate: string }) {
  return (
    <View style={{ position: "absolute", right: -AUDIO_BADGE / 2 + 2, bottom: -AUDIO_BADGE / 2 + 2, width: AUDIO_BADGE, height: AUDIO_BADGE, borderRadius: AUDIO_BADGE / 2, backgroundColor: plate, alignItems: "center", justifyContent: "center" }}>
      <Symbol name={mute ? "speaker.slash.fill" : "speaker.wave.2.fill"} size={7} color={color} style={{ width: AUDIO_BADGE - 2, height: AUDIO_BADGE - 2 }} />
    </View>
  );
}

function MuteToggle({ tabId, mute, color }: { tabId: string; mute: MuteState; color: string }) {
  const tip = useTooltip(muteTitle(mute));
  const pressMotion = usePressScaleMotion(true, buttonMotion.iconPressScale);
  const pressStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  return (
    <Pressable onPress={() => toggleMute(tabId)} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} style={{ marginLeft: CHIP_LABEL_GAP }} tooltip={tip}>
      <Animated.View pointerEvents="none" style={pressStyle}>
        <Symbol name={mute ? "speaker.slash" : "speaker.wave.2"} size={11} color={color} style={{ width: 16, height: 16 }} />
      </Animated.View>
    </Pressable>
  );
}

function ChipRow({
  hover,
  dragged,
  quiet,
  pressed,
  inset,
  plate,
  action,
  badge,
  children,
}: {
  hover: ChipHover;
  dragged: boolean;
  quiet: boolean;
  pressed: boolean;
  inset?: number;
  plate: string;
  action: ReactNode;
  badge: ReactNode;
  children: ReactNode;
}) {
  const hovered = useChipHovered(hover);
  const closing = inset === undefined && hovered && !!action;
  return (
    <ItemRow hovered={(hovered || dragged) && !quiet} pressed={pressed} inset={inset}>
      {children}
      {inset === undefined && !closing ? badge : null}
      {closing ? (
        <View pointerEvents="box-none" style={CLOSE_OVERLAY}>
          <View style={{ borderRadius: radius.control, backgroundColor: plate }}>{action}</View>
        </View>
      ) : null}
    </ItemRow>
  );
}

const CLOSE_OVERLAY = { position: "absolute", right: CHIP_PAD.right, top: 0, bottom: 0, justifyContent: "center" } as const;

function groupTray(color: GroupColor | null | undefined, tokens: SidebarTokens): string {
  if (color === undefined) return ink.clear;
  if (color === "none") return ink.clear;
  const tint = groupTint(color);
  return tint ? withAlpha(tint, GROUP_TRAY_ALPHA) : tokens.groupFill;
}

export function ItemRow({ hovered, pressed, padded = true, inset, children }: { hovered: boolean; pressed: boolean; padded?: boolean; inset?: number; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: ITEM_TOP,
        height: ITEM_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: inset ?? (padded ? CHIP_PAD.left : 0),
        paddingRight: inset ?? (padded ? CHIP_PAD.right : 0),
      }}
    >
      <HoverFill shown={pressed || hovered} color={pressed ? theme.tabPressed : theme.tabHover} radius={tabRadius()} />
      {children}
    </View>
  );
}
