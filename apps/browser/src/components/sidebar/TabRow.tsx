import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, TextInput, View, type GestureResponderEvent, type Insets, type TextStyle } from "react-native";
import { toggleMute } from "../../state/browser/actions";
import { hex, layout, useTheme } from "../ui/theme";
import { useIsActiveTab, usePageProfileId, useTab, useWindow, useWindowId } from "../../state/browser/hooks";
import { returnToPinnedUrl } from "../../state/pins/actions";
import { useSplitRowPanes, useTabBadged } from "../../state/sidebar/hooks";
import { muteTitle } from "../../state/tabs/mute";
import { usePictureInPicture } from "../../state/media/media";
import { HoverSlot } from "../ui/HoverSlot";
import { ActivitySpinner, FadeLabel, HoverSwap, ink, OutsidePressArea, radius, sidebarFont, sidebarLineHeight, space, Symbol, typeFace, useHover, withAlpha } from "../ui";
import { isPinnedRow, tabTitle } from "../../state/browser/model";
import { awayFromPin, rowAwayTitle } from "../../state/pins/organize";
import { hidesRowIcon } from "../../state/pins/rowIcons";
import { commitRename, endRename, startRename } from "../../state/sidebar/actions";
import { useDragItem } from "./DragProvider";
import { SplitDropHalf } from "./DropMarks";
import { PreviewFade, previewFade, SplitPreview, useSplitPreview } from "./SplitPreview";
import { profileSurfaces } from "./profileSurfaces";
import { SPLIT_PANE, splitPaneShape } from "./splitPaneGeometry";
import { useShift, type EntryMotion } from "./EntryMotion";
import { useRowHover, useRowHoverCell } from "./hoverController";
import { RowCloseSlot, RowHoverFill } from "./RowHoverParts";
import { RowCloseButton } from "./RowCloseButton";
import { pressPaneClose, useTabCloseControlWhile } from "../../state/sidebar/closeControl";
import { modifiersOf } from "../../lib/keys";
import { ACTIVE, ICON_MARKS, IN_SPLIT, LOADING, mutedBy, PLAYING, SELECTED, SLEEPING, STRUCK, useRowState, useStruckTitle } from "../../state/sidebar/rowState";
import { registerRow, useSidebarUi } from "../../state/sidebar/sidebarUi";
import { RowTabIcon, TabIcon } from "./TabIcon";
import { TabBadges } from "../media/TabBadges";
import { UnreadCount } from "../unread/UnreadBadge";
import { useTabUnread } from "../../state/tabs/unread";
import { titleWithoutUnread } from "../../lib/unread";
import { ROW_GLYPH, SIDEBAR_TYPE, SLEEPING_TITLE_OPACITY, TAB_ROW, useSidebarTokens } from "./tokens";
import { useSidebarRowLook } from "./rowLook";
import { rowSurfaceFrame, rowTitleFrame, SidebarRowLabel, SidebarRowSurface, useRowSurfaceLayer } from "./SidebarRow";
import { AwayTitleLabel } from "./AwayTitle";
import { withShortcut } from "../../state/commands/commandShortcuts";
import { TabPressArea, tabPressView } from "./TabPressArea";
import type { TabPress } from "../../state/sidebar/heldTabPress";
import { entryKey } from "../../state/sidebar/entryKey";
import type { RowSection } from "./dragModel";
import type { SplitDropSide } from "../../state/drag/drops";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";
import { t } from "../../lib/uiLanguage";


export const TabRowItem = memo(function TabRowItem({
  tabId,
  section,
  parentGroup,
  motion = null,
}: {
  tabId: string;
  section: RowSection;
  parentGroup?: string;
  motion?: EntryMotion | null;
}) {
  const { wrapper, handle, splitSide } = useDragItem(entryKey("tab", tabId), { kind: "row", tabIds: [tabId], section, parentGroup }, motion?.clip);
  return (
    <Animated.View ref={wrapper.ref} style={wrapper.style} {...handle}>
      <TabRow tabId={tabId} splitSide={splitSide} shift={motion?.shift ?? null} />
    </Animated.View>
  );
});

export const TabRow = memo(function TabRow({
  tabId,
  splitSide = null,
  shift = null,
}: {
  tabId: string;
  splitSide?: SplitDropSide | null;
  shift?: Animated.Value | null;
}) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const windowId = useWindowId();
  const { tab, flags } = useRowState(tabId, windowId);
  const active = !!(flags & ACTIVE);
  const selected = !!(flags & SELECTED);
  const playingAudio = !!(flags & PLAYING);
  const mute = mutedBy(flags);
  const loading = !!(flags & LOADING);
  const [pip, togglePip] = usePictureInPicture(tabId);
  const renaming = useSidebarUi((u) => u.renaming?.kind === "tab" && u.renaming.id === tabId);
  const { cell, hoverProps } = useRowHoverCell(windowId, renaming ? null : { kind: "tab", id: tabId });
  const [moved, movedRef] = useShift(shift, useCallback((v: View | null) => registerRow(windowId, tabId, v), [windowId, tabId]));
  const backToPin = useHover();
  const { backToPinHint, quiet, plainTooltip } = useSidebarRowLook();
  const press = useRef<TabPress | null>(null);
  const unread = useTabUnread(tabId);
  const badged = useTabBadged(tabId);
  const [unreadDrawn, setUnreadDrawn] = useState(false);
  const showsUnread = !!unread || unreadDrawn;
  const resettable = !!tab && (isPinnedRow(tab) || !tab.pin) && awayFromPin(tab);
  const struck = !!(flags & STRUCK);
  const preview = useSplitPreview(splitSide, 1);
  const [pressed, setPressed] = useState(false);
  const fill = active ? (quiet ? tokens.quietWash : theme.tabSelected) : selected ? tokens.multiSelected : ink.clear;
  const plain = !active && !selected;
  const pressedFill = quiet ? tokens.quietPressed : theme.tabPressed;
  cell.plain = plain;
  useLayoutEffect(() => {
    if (cell.hovered) cell.refresh();
  }, [cell, plain]);
  const surface = useRowSurfaceLayer({
    fill: selected && !active && pressed ? pressedFill : fill,
    selected: active && !quiet,
    border: (active && !quiet) || selected ? 0.5 : 0,
    stroke: selected && !active ? tokens.multiSelectedStroke : undefined,
  });
  const resetting = resettable && backToPin.hovered && !renaming;
  const textOnly = hidesRowIcon(tab, badged);
  const iconMarks = flags & (ICON_MARKS | SLEEPING);
  const resetInk = resetting && active ? theme.rowSelectedText : theme.textTab;
  const iconSlot = useMemo(() => {
    const shown = tab;
    if (!shown) return null;
    return (
            <View {...(shown.pinnedUrl ? backToPin.hoverProps : null)} style={textOnly ? NO_SLOT : undefined}>
              {resettable ? (
                <Pressable
                  onPress={() => returnToPinnedUrl(shown.id)}
                  tooltip={withShortcut(t(`Back to Pinned URL`), backToPinHint)}
                  accessibilityRole="button"
                  accessibilityLabel={t(`Back to Pinned URL`)}
                >
                  <View pointerEvents="none">
                    {resetting ? (
                      <View style={{ width: ROW_GLYPH.box, height: ROW_GLYPH.box, alignItems: "center", justifyContent: "center" }}>
                        <Symbol name="arrow.uturn.backward" size={ROW_GLYPH.small} weight="semibold" color={resetInk} style={{ width: ROW_GLYPH.box, height: ROW_GLYPH.box }} />
                      </View>
                    ) : (
                      <View>
                        <RowTabIcon tabId={shown.id} url={shown.url} favicon={shown.favicon} icon={shown.customIcon} profileId={shown.profileId} marks={iconMarks & ICON_MARKS} sleeping={!!(iconMarks & SLEEPING)} compact={quiet} />
                        <TabBadges tabId={shown.id} />
                      </View>
                    )}
                  </View>
                </Pressable>
              ) : (
                <>
                  <RowTabIcon tabId={shown.id} url={shown.url} favicon={shown.favicon} icon={shown.customIcon} profileId={shown.profileId} marks={iconMarks & ICON_MARKS} sleeping={!!(iconMarks & SLEEPING)} compact={quiet} />
                  <TabBadges tabId={shown.id} />
                </>
              )}
            </View>
    );
  }, [tab, iconMarks, quiet, resettable, resetting, textOnly, backToPinHint, resetInk, backToPin.hoverProps]);
  if (!tab) return null;
  const title = resetting ? t(`Back to Pinned URL`) : tab.customTitle ? tabTitle(tab) : titleWithoutUnread(tabTitle(tab), unread);
  const away = resettable && !resetting ? rowAwayTitle(tab) : null;
  const hoverFill = quiet ? tokens.quietHover : theme.tabHover;
  const titleColor = quiet ? hex(withAlpha(theme.textTab, active ? tokens.quietActiveText : tokens.quietText)) : active ? theme.rowSelectedText : theme.textTab;

  return (
    <View
      {...moved}
      ref={movedRef}
      {...hoverProps}
      style={moved.style as object}
      onDoubleClick={() => void startRename(windowId, { kind: "tab", id: tabId })}
    >
      {tabPressView({ windowId, tab, hitSlop: rowGapSlop(0), selected, press, inSplit: !!(flags & IN_SPLIT), plainTooltip, onPressChange: setPressed, children: (
        <>
          <RowHoverFill cell={cell} pressed={pressed} color={pressed ? pressedFill : hoverFill} radius={radius.chrome} />
          {surface}
          {previewFade(preview, <>
            {iconSlot}
            {pip && (
              <StatusIconButton icon="pip" color={theme.textTab} tooltip={t(`Exit Picture in Picture`)} onPress={togglePip} />
            )}
            {(playingAudio || mute) && (
              <StatusIconButton icon={mute ? "speaker.slash" : "speaker.wave.2"} color={theme.textTab} tooltip={muteTitle(mute)} onPress={() => toggleMute(tab.id)} />
            )}
            {renaming ? (
              <RenameField
                initial={tab.customTitle ?? tab.title}
                placeholder={tab.title || t(`Tab name`)}
                color={active ? theme.rowSelectedText : theme.textPrimary}
                onDone={(text) => (text === null ? endRename({ kind: "tab", id: tabId }) : commitRename({ kind: "tab", id: tabId }, text))}
              />
            ) : away ? (
              <AwayTitleLabel away={away} color={titleColor} fontSize={quiet ? SIDEBAR_TYPE.compact : SIDEBAR_TYPE.title} height={TAB_ROW.titleHeight} struck={struck} style={AWAY_FRAME} />
            ) : (
              <SidebarRowLabel text={title} color={titleColor} compact={quiet} struck={struck && !resetting} />
            )}
            <RowCloseSlot cell={cell} tabId={tab.id} renaming={renaming}>
              {loading || showsUnread ? (
                <>
                  {loading && <ActivitySpinner style={{ width: 12, height: 12, marginRight: space.xxs }} />}
                  {showsUnread && <UnreadCount unread={unread} ink={active ? theme.rowSelectedText : theme.textTab} onDrawn={setUnreadDrawn} />}
                </>
              ) : null}
            </RowCloseSlot>
            </>, rowSurfaceFrame(textOnly ? TAB_ROW.contentLeft - TAB_ROW.titleGap : TAB_ROW.contentLeft))}
        </>
      ) })}
      {preview.values ? <SplitPreview panes={SINGLE(tabId)} values={preview.values} rowActive={active && !quiet} /> : null}
    </View>
  );
});

const AWAY_FRAME = { flex: 1, marginLeft: TAB_ROW.titleGap } as const;
const singles = new Map<string, string[]>();
const SINGLE = (tabId: string) => singles.get(tabId) ?? (singles.set(tabId, [tabId]), singles.get(tabId)!);
const NO_SLOT = { display: "none" } as const;

function StatusIconButton({ icon, color, tooltip, onPress }: { icon: string; color: string; tooltip: string; onPress: (event: GestureResponderEvent) => void }) {
  const pressMotion = usePressScaleMotion(true, buttonMotion.iconPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  const glyphFrame = { width: ROW_GLYPH.wide, height: ROW_GLYPH.box, alignItems: "center", justifyContent: "center" } as const;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={pressMotion.onPressIn}
      onPressOut={pressMotion.onPressOut}
      style={{ marginLeft: space.s }}
      tooltip={tooltip}
      accessibilityRole="button"
      accessibilityLabel={tooltip}
    >
      <Animated.View style={[glyphFrame, scaleStyle]}>
        <Symbol name={icon} size={ROW_GLYPH.symbol} color={color} style={glyphFrame} />
      </Animated.View>
    </Pressable>
  );
}

export function RenameField({
  initial,
  placeholder,
  color,
  fontSize = SIDEBAR_TYPE.title,
  weight,
  onDone,
}: {
  initial: string;
  placeholder: string;
  color: string;
  fontSize?: number;
  weight?: TextStyle["fontWeight"];
  onDone(text: string | null): void;
}) {
  const theme = useTheme();
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const input = useRef<TextInput>(null);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  return (
    <OutsidePressArea onOutsidePress={() => finish(text)} style={rowTitleFrame()}>
      <TextInput
        ref={input}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={theme.placeholder}
        selectionColor={theme.selection}
        selectTextOnFocus
        enableFocusRing={false}
        onSubmitEditing={() => finish(text)}
        onBlur={() => finish(text)}
        keyDownEvents={[{ key: t(`Escape`) }]}
        onKeyDown={(e) => e.nativeEvent.key === "Escape" && finish(null)}
        style={{ flex: 1, fontSize, fontWeight: weight, color, paddingVertical: 0, paddingHorizontal: 0, transform: [{ translateY: TAB_ROW.renameTextOffset }], ...typeFace() }}
      />
    </OutsidePressArea>
  );
}

export const SplitRowItem = memo(function SplitRowItem({
  splitId,
  section,
  parentGroup,
  motion = null,
}: {
  splitId: string;
  section: RowSection;
  parentGroup?: string;
  motion?: EntryMotion | null;
}) {
  const windowId = useWindowId();
  const tabIds = useSplitRowPanes(splitId);
  const { wrapper, handle, splitSide } = useDragItem(entryKey("split", splitId), { kind: "split", tabIds, section, parentGroup }, motion?.clip);
  const preview = useSplitPreview(splitSide, tabIds.length);
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const profileId = usePageProfileId();
  const active = useWindow(windowId, (w) => tabIds.includes(w?.activeTabIds[profileId] ?? ""));
  const { hovered, hoverProps } = useRowHover(windowId, null);
  const [moved, movedRef] = useShift(motion?.shift ?? null, useCallback((v: View | null) => registerRow(windowId, entryKey("split", splitId), v), [windowId, splitId]));
  if (tabIds.length < 2) return null;
  const splitBorder = active ? 1 : 0;
  return (
    <Animated.View ref={wrapper.ref} style={wrapper.style} {...handle}>
      <View {...moved} ref={movedRef} {...hoverProps} style={moved.style as object}>
        <SidebarRowSurface
          fill={active ? theme.tabSelected : hovered ? theme.tabHover : ink.clear}
          selected={active}
          border={splitBorder}
          padLeft={SPLIT_PANE.inset}
          padRight={SPLIT_PANE.inset}
        >
          <PreviewFade preview={preview}>
            {tabIds.map((id, i) => (
              <View key={id} style={i > 0 ? SPLIT_SLOT_AFTER : SPLIT_SLOT}>
                <SplitPane tabId={id} windowId={windowId} rowActive={active} />
              </View>
            ))}
          </PreviewFade>
        </SidebarRowSurface>
        {preview.values ? <SplitPreview panes={tabIds} values={preview.values} rowActive={active} /> : <SplitDropHalf side={splitSide} fill={tokens.splitDropFill} />}
      </View>
    </Animated.View>
  );
});


const gapSlops = new Map<number, Insets>();

function rowGapSlop(inset: number): Insets {
  const reach = inset + layout.rowGap / 2;
  let slop = gapSlops.get(reach);
  if (!slop) gapSlops.set(reach, (slop = { top: reach, bottom: reach }));
  return slop;
}
const SPLIT_SLOT = { flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 } as const;
const SPLIT_SLOT_AFTER = { ...SPLIT_SLOT, marginLeft: SPLIT_PANE.gap } as const;
const CLOSE_SLOT = { marginLeft: SPLIT_PANE.closeInset } as const;


function SplitPane({ tabId, windowId, rowActive }: { tabId: string; windowId: string; rowActive: boolean }) {
  const theme = useTheme();
  const tab = useTab(tabId);
  const active = useIsActiveTab(tabId);
  const struck = useStruckTitle(tabId);
  const { hovered, hoverProps } = useRowHover(windowId, { kind: "tab", id: tabId });
  const closeControl = useTabCloseControlWhile(tabId, hovered);
  const shape = splitPaneShape();
  const [width, setWidth] = useState(Infinity);
  const surfaces = profileSurfaces(theme);
  const tones = rowActive ? surfaces.activePanes : surfaces.idlePanes;
  if (!tab) return null;
  const closeShown = hovered && !!closeControl;
  const iconGivesWay = closeShown && width < space.s + ROW_GLYPH.box + space.xs + shape.closeBox + SPLIT_PANE.closeInset * 2;
  return (
    <View {...hoverProps} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ flex: 1, minWidth: 0 }}>
      <TabPressArea windowId={windowId} tab={tab} hitSlop={rowGapSlop(SPLIT_PANE.inset)}>
        {({ pressed }) => (
          <View
            style={{
              height: shape.height,
              borderRadius: shape.corner,
              flexDirection: "row",
              alignItems: "center",
              paddingLeft: space.s,
              paddingRight: SPLIT_PANE.closeInset,
            }}
          >
            <HoverSwap shown={pressed || (!active && hovered)} instant={active && !pressed} rest={active && rowActive ? tones.selected : rowActive ? tones.rest : undefined} color={pressed ? tones.pressed : tones.hover} radius={shape.corner} />
            {iconGivesWay ? null : <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} compact />}
            <FadeLabel text={tabTitle(tab)} fontSize={sidebarFont.small.fontSize} color={active ? theme.rowSelectedText : theme.textTab} strikethrough={struck} style={{ flex: 1, height: Math.max(ROW_GLYPH.box, sidebarLineHeight.small + 1), marginLeft: space.xs, opacity: struck ? SLEEPING_TITLE_OPACITY : 1 }} />
            <HoverSlot
              hovered={hovered}
              reserve="hover"
              width={shape.closeBox}
              style={CLOSE_SLOT}
              hover={closeControl && <RowCloseButton icon={closeControl.icon} box={shape.closeBox} radius={shape.closeCorner} onPress={(e: GestureResponderEvent) => pressPaneClose(tab.id, modifiersOf(e).altKey)} tooltip={closeControl.tooltip} />}
            />
          </View>
        )}
      </TabPressArea>
    </View>
  );
}
