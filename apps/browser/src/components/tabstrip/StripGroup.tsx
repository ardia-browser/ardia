import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { currentGroup } from "../../state/browser/current";
import { useGroup, usePageProfileId, useWindowId } from "../../state/browser/hooks";
import { updateGroup } from "../../state/groups/actions";
import { pressGroupClose, useGroupCloseControl } from "../../state/sidebar/closeControl";
import { openGroupMenu } from "../../state/sidebar/menus";
import { moveInGroup, tuckGroup, useHasTuckTarget } from "../../state/tabs/topStrip";
import { groupTint, useSidebarTokens } from "../sidebar/tokens";
import { Button, ContextMenuArea, Divider, FadeLabel, useTooltip } from "../ui";
import { useTheme } from "../ui/theme";
import { font, ink, weight, withAlpha } from "../ui/tokens";
import { FolderMeasures, GroupMember, StripGroupIcon } from "./GroupMember";
import type { StripGroupEntry, StripMember } from "../../state/tabs/topStrip";
import { hasVisibleMembers, overflowCountRoom, dragGeometry, dropIndex, GROUP_MARGIN_LEFT, GROUP_MARGIN_RIGHT, groupLayout, holds, MEMBERS_INSET, TAIL_COLLAPSED, memberInteractive, tabsOf, type DragGeometry } from "./stripGroups";
import { CHIP_HAIRLINE, GAP, GROUP_CHIP_PAD, GROUP_DIVIDER_LENGTH, GROUP_OVERFLOW_GAP, GROUP_TITLE_GAP, GROUP_TITLE_MAX, GROUP_TITLE_TIGHT, GROUP_TRAY_ALPHA, ITEM_HEIGHT, ITEM_TOP, MID, STRIP_COLORS, tabRadius, TOP_STRIP_HEIGHT } from "./tokens";
import { noteTabStripGroupToggle } from "../../state/telemetry/tabStripCounts";
import { useStripDrag } from "./useStripDrag";
import { nameKey } from "./model";
import { setMeasuredWidth } from "../../state/windows/measuredWidths";
import { useChipHover, useChipHovered, type ChipHover } from "./reachableHover";
import { GROUP_NAME_INSET, memberClipEdge, TOGGLE_MS, toggleEase } from "./stripToggle";
import { reduceMotion } from "../ui/reduceMotion";

export function StripGroup({
  entry,
  geometry,
  from,
  chip,
  tabWidth,
  activeId,
  chipWidth,
  onChipFrame,
  memberWidth,
  folderMeasured,
  overflowCount,
  tightName,
}: {
  entry: StripGroupEntry;
  geometry: DragGeometry;
  from: number;
  chip: number;
  tabWidth: (tabId: string) => number;
  activeId: string;
  chipWidth: number | undefined;
  onChipFrame: (width: number) => void;
  memberWidth: (m: StripMember) => number;
  folderMeasured: (groupId: string) => boolean;
  overflowCount: number;
  tightName: boolean;
}) {
  const theme = useTheme();
  const windowId = useWindowId();
  const profileId = usePageProfileId();
  const group = useGroup(entry.id, (g) => g);
  const groupClose = useGroupCloseControl(entry.id);
  const hover = useChipHover();
  const expanded = !entry.collapsed;
  const chipTip = useTooltip(expanded ? "Collapse Group" : "Expand Group");
  const widths = entry.members.map(memberWidth);
  const shown = entry.members.findIndex((m) => holds(m, activeId));
  const chipSize = chipWidth === undefined ? 0 : chipWidth + overflowCountRoom(overflowCount);
  const { offsets, width } = groupLayout(chipSize, widths, GAP, expanded, shown);
  const members = useMemo(() => dragGeometry(entry.members.map((m, i) => ({ tabIds: tabsOf(m), width: widths[i]! })), GAP), [entry.members, widths.join()]);
  const folderIds = useMemo(() => entry.members.flatMap((m) => (m.kind === "folder" ? [m.id] : [])), [entry.members]);
  const tuckable = useHasTuckTarget(!expanded && shown >= 0, windowId, profileId, entry.id);
  const open = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  const size = useRef(new Animated.Value(width)).current;
  const state = `${expanded}:${shown >= 0 ? entry.members[shown]!.id : ""}`;
  const settled = useRef(state);
  const [gliding, setGliding] = useState<"toggle" | "shift" | null>(null);
  const pending = settled.current !== state && !reduceMotion();
  const toggling = pending && !settled.current.startsWith(`${expanded}:`);
  const moving = gliding !== null || pending;
  const revealed = expanded || toggling || gliding === "toggle";
  const glides = useRef(0);
  const placed = useRef(new Map<string, { width: number; offset: number }>());
  if (expanded) placed.current = new Map(entry.members.map((m, i) => [m.id, { width: widths[i]!, offset: offsets[i]! }]));
  const placeOf = (m: StripMember, i: number) => {
    const before = expanded ? undefined : placed.current.get(m.id);
    return { width: i !== shown && before ? before.width : widths[i]!, offset: before ? before.offset : offsets[i]! };
  };
  useLayoutEffect(() => {
    const glide = (value: Animated.Value, toValue: number) => Animated.timing(value, { toValue, duration: TOGGLE_MS, easing: toggleEase, useNativeDriver: false });
    const both = (kind: "toggle" | "shift") => {
      const id = ++glides.current;
      if (reduceMotion()) {
        open.stopAnimation();
        size.stopAnimation();
        open.setValue(expanded ? 1 : 0);
        size.setValue(width);
        setGliding(null);
        return;
      }
      setGliding(kind);
      Animated.parallel([glide(open, expanded ? 1 : 0), glide(size, width)]).start(() => id === glides.current && setGliding(null));
    };
    if (settled.current !== state) {
      const kind = !settled.current.startsWith(`${expanded}:`) || gliding === "toggle" ? "toggle" : "shift";
      settled.current = state;
      both(kind);
    } else if (moving) both(gliding ?? "shift");
    else size.setValue(width);
  }, [state, width]);
  const fade = useMemo(() => open.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: "clamp" }), []);
  const drag = useStripDrag({
    tabId: null,
    ids: () => currentGroup(entry.id)?.tabIds ?? [],
    pinned: false,
    groupId: null,
    geometry,
    from,
    width: 0,
    gap: 0,
    axis: "x",
    local: true,
    drop: (dx) => {
      const to = dropIndex(geometry, from, dx);
      if (to === from) return true;
      const others = geometry.slots.filter((_, i) => i !== from);
      moveInGroup(entry.id, others[to]?.tabIds[0] ?? null);
      return true;
    },
  });
  const tail = useMemo(() => Animated.add(size, memberClipEdge(0)), []);
  const shownOffset = shown >= 0 ? placeOf(entry.members[shown]!, shown).offset : 0;
  const shownEdge = useMemo(() => Animated.add(size, shownOffset - TAIL_COLLAPSED), [shownOffset]);
  const shifting = moving && !revealed;
  if (!group) return null;
  const tint = groupTint(group.color);
  const bare = group.color === "none";
  const divider = STRIP_COLORS[theme.dark ? "dark" : "light"].groupDivider;
  const membersShown = hasVisibleMembers(entry);
  const tuck = () => tuckGroup(windowId, profileId, entry.id);
  return (
    <Animated.View
      ref={drag.ref}
      style={{ width: size, height: TOP_STRIP_HEIGHT, marginLeft: GROUP_MARGIN_LEFT, marginRight: GROUP_MARGIN_RIGHT, zIndex: drag.style.zIndex, transform: drag.style.transform, opacity: chipWidth === undefined ? 0 : 1 }}
    >
      <GroupFill hover={hover} width={size} tint={tint} bare={bare} />
      {membersShown ? <Animated.View pointerEvents="none" style={{ position: "absolute", left: chipSize + 0.75, top: MID - 7.5, width: 0.5, height: 15, backgroundColor: divider, opacity: fade }} /> : null}
      <FolderMeasures ids={folderIds} />
      {entry.members.map((m, i) => (
        <GroupMember
          key={m.id}
          member={m}
          width={placeOf(m, i).width}
          start={chipSize + MEMBERS_INSET}
          offset={placeOf(m, i).offset}
          clip={i !== shown ? (moving ? tail : null) : shifting ? shownEdge : null}
          revealed={revealed}
          open={open}
          interactive={memberInteractive(i === shown, expanded, moving)}
          shown={i === shown}
          parked={!expanded && i !== shown && (!moving || !placed.current.has(m.id))}
          geometry={members}
          from={expanded ? i : -1}
          chip={chip}
          tabWidth={tabWidth}
          activeId={activeId}
          measured={m.kind !== "folder" || folderMeasured(m.id)}
          tuck={tuckable && i === shown ? tuck : undefined}
          out={{ top: geometry, slot: from, chip: chipSize, expanded, left: (geometry.lefts[from] ?? 0) + chipSize + MEMBERS_INSET + (expanded ? offsets[i]! : 0) }}
        />
      ))}
      {membersShown ? (
        <Animated.View pointerEvents={expanded ? "box-none" : "none"} mouseDownCanMoveWindow={false} style={{ position: "absolute", top: ITEM_TOP, height: ITEM_HEIGHT, left: tail, flexDirection: "row", alignItems: "center", opacity: fade }}>
          <Divider vertical length={GROUP_DIVIDER_LENGTH} color={divider} />
          {groupClose && <Button variant="icon" icon={groupClose.icon === "xmark" ? "xmark.square" : "minus.square"} size="m" glyph={font.badge.fontSize} weight="semibold" onPress={() => pressGroupClose(entry.id)} tooltip={groupClose.tooltip} />}
        </Animated.View>
      ) : null}
      <View
        {...hover.hoverProps}
        {...drag.panHandlers}
        mouseDownCanMoveWindow={false}
        tooltip={chipTip}
        style={{ position: "absolute", left: 0, top: ITEM_TOP, height: ITEM_HEIGHT }}
      >
        <ContextMenuArea onContextMenu={() => void openGroupMenu(windowId, entry.id)}>
          <Pressable
            onPress={() => {
              noteTabStripGroupToggle(windowId, performance.now());
              updateGroup(entry.id, { collapsed: expanded });
            }}
            style={{ height: ITEM_HEIGHT, flexDirection: "row", alignItems: "center", paddingLeft: GROUP_CHIP_PAD.left, paddingRight: GROUP_CHIP_PAD.right }}
          >
            <View onLayout={(e) => onChipFrame(Math.ceil((e.nativeEvent.layout.width + GROUP_CHIP_PAD.left + GROUP_CHIP_PAD.right) * 2) / 2)}>
              <StripGroupIcon icon={group.icon} color={group.color} open={expanded} />
            </View>
            <GroupName
              name={group.name || `${group.tabIds.length} ${group.tabIds.length === 1 ? "Tab" : "Tabs"}`}
              cap={tightName ? GROUP_TITLE_TIGHT : GROUP_TITLE_MAX}
              color={shown >= 0 ? theme.textPrimary : theme.textTab}
              onNatural={(width) => setMeasuredWidth(nameKey(entry.id), width)}
            />
            {overflowCount > 0 ? <OverflowCount count={overflowCount} /> : null}
          </Pressable>
        </ContextMenuArea>
      </View>
    </Animated.View>
  );
}

function GroupName({ name, cap, color, onNatural }: { name: string; cap: number; color: string; onNatural: (width: number) => void }) {
  const [natural, setNatural] = useState<number | null>(null);
  const width = natural === null ? 0 : Math.min(natural, cap) + GROUP_NAME_INSET * 2;
  return (
    <View style={{ marginLeft: GROUP_TITLE_GAP - GROUP_NAME_INSET, width, height: ITEM_HEIGHT, justifyContent: "center" }}>
      <View pointerEvents="none" accessibilityElementsHidden style={NAME_MEASURE}>
        <Text accessible={false} numberOfLines={1} onLayout={(e) => { const width = Math.ceil(e.nativeEvent.layout.width * 2) / 2; setNatural(width); onNatural(width); }} style={{ ...font.small, fontWeight: weight.semibold, fontVariant: ["tabular-nums"] }}>
          {name}
        </Text>
      </View>
      <FadeLabel text={name} fontSize={font.small.fontSize} weight="semibold" color={color} style={{ width, height: 16 }} />
    </View>
  );
}

const NAME_MEASURE = { position: "absolute", left: 0, top: 0, width: 10000, flexDirection: "row", opacity: 0 } as const;

function OverflowCount({ count }: { count: number }) {
  const theme = useTheme();
  const label = `${count} more ${count === 1 ? "tab" : "tabs"} in the open tabs menu`;
  return (
    <Text numberOfLines={1} accessibilityLabel={label} style={{ width: overflowCountRoom(count), paddingLeft: GROUP_OVERFLOW_GAP, ...font.small, fontWeight: weight.medium, fontVariant: ["tabular-nums"], color: theme.textTab }}>
      {`+${count}`}
    </Text>
  );
}

function GroupFill({ hover, width, tint, bare }: { hover: ChipHover; width: Animated.Value; tint: string | null | undefined; bare: boolean }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const hovered = useChipHovered(hover);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        top: ITEM_TOP,
        width,
        height: ITEM_HEIGHT,
        borderRadius: tabRadius(),
        borderWidth: CHIP_HAIRLINE,
        borderColor: bare ? ink.clear : theme.pinnedRestingStroke,
        backgroundColor: tint ? withAlpha(tint, hovered ? 0.24 : GROUP_TRAY_ALPHA) : hovered ? tokens.groupHeaderHover : bare ? ink.clear : tokens.groupFill,
      }}
    />
  );
}
