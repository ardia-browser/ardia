import { useEffect, useMemo, useRef } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { useGroup, useWindowId } from "../../state/browser/hooks";
import { hasOwnGroupIcon } from "../../state/groups/groupIcons";
import { iconSymbol } from "../../lib/customIcon";
import { useGroupLabel } from "../../state/groups/hooks";
import { openGroupMenu } from "../../state/sidebar/menus";
import { openFolderMenu } from "../../state/tabs/topStrip";
import { setMeasuredWidth, useMeasuredWidth } from "../../state/windows/measuredWidths";
import { groupTint, useSidebarTokens } from "../sidebar/tokens";
import type { GroupColor } from "../../state/browser/types";
import { AnimatedFolder } from "../sidebar/AnimatedFolder";
import { ContextMenuArea, Offstage, Symbol, useOffstage, useTooltip } from "../ui";
import { curve, useGated } from "../ui/motion";
import { useTheme } from "../ui/theme";
import { font, ink, space, weight, withAlpha } from "../ui/tokens";
import { useChipHover, useChipHovered } from "./reachableHover";
import { folderKey, type GroupOut } from "./model";
import type { StripMember } from "../../state/tabs/topStrip";
import { TabIcon } from "../sidebar/TabIcon";
import { SplitChip } from "./SplitChip";
import { MEMBERS_INSET, type DragGeometry } from "./stripGroups";
import { DraggableChip, TabChip } from "./TabChip";
import { CHIP_HAIRLINE, FOLDER_HEIGHT, FOLDER_PAD, folderRadius, FOLDER_TITLE_GAP, FOLDER_TITLE_MAX, MID, STRIP_FOLDER_SIDE, TOP_STRIP_HEIGHT, TUCK_FADE_MS } from "./tokens";

export function GroupMember({
  member,
  width,
  start,
  offset,
  clip,
  revealed,
  open,
  interactive,
  shown,
  parked,
  geometry,
  from,
  chip,
  tabWidth,
  activeId,
  measured,
  tuck,
  out,
}: {
  member: StripMember;
  width: number;
  start: number;
  offset: number;
  clip: Animated.AnimatedAddition<number> | null;
  revealed: boolean;
  open: Animated.Value;
  interactive: boolean;
  shown: boolean;
  parked: boolean;
  geometry: DragGeometry;
  from: number;
  chip: number;
  tabWidth: (tabId: string) => number;
  activeId: string;
  measured: boolean;
  tuck?: () => void;
  out: GroupOut;
}) {
  const offstage = useOffstage() || !interactive;
  const shownValue = useRef(new Animated.Value(shown ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(shownValue, { toValue: shown ? 1 : 0, duration: TUCK_FADE_MS, easing: curve.enter, useNativeDriver: false }).start();
  }, [shown]);
  const visible = useMemo(
    () => (clip ? Animated.subtract(clip, start + offset).interpolate({ inputRange: [0, width], outputRange: [0, width], extrapolate: "clamp" }) : width),
    [clip, start, offset, width],
  );
  const sliding = useMemo(() => open.interpolate({ inputRange: [0, 1], outputRange: [start, start + offset] }), [open, start, offset]);
  const left = useGated(shown, sliding, start + offset);
  const opacity = useGated(!revealed, shownValue, 1);
  return (
    <Animated.View pointerEvents={interactive ? "box-none" : "none"} style={{ position: "absolute", top: 0, left, width: visible, overflow: clip ? "hidden" : "visible", height: TOP_STRIP_HEIGHT, opacity: measured ? opacity : 0, zIndex: shown ? 2 : 1, display: parked ? "none" : "flex" }}>
      <View pointerEvents="box-none" style={{ width, height: TOP_STRIP_HEIGHT }}>
      <Offstage.Provider value={offstage}>
        {member.kind === "folder" ? (
          <FolderMember groupId={member.id} chip={chip} shownTab={member.tabIds.includes(activeId) ? activeId : null} tuck={tuck} />
        ) : member.kind === "split" ? (
          <SplitChip tabIds={member.tabIds} width={width} paneWidths={member.tabIds.map(tabWidth)} geometry={geometry} from={from} group={member.group} />
        ) : (
          <DraggableChip tabId={member.id} width={width} geometry={geometry} from={from} group={member.group} tuck={tuck} out={out} />
        )}
      </Offstage.Provider>
      </View>
    </Animated.View>
  );
}

function FolderMember({ groupId, chip, shownTab, tuck }: { groupId: string; chip: number; shownTab: string | null; tuck?: () => void }) {
  const width = useMeasuredWidth(folderKey(groupId)) ?? 0;
  const hover = useChipHover();
  return (
    <View pointerEvents="box-none" style={{ height: TOP_STRIP_HEIGHT }}>
      <FolderChip groupId={groupId} holding={!!shownTab} />
      {shownTab && (
        <View style={{ position: "absolute", top: 0, left: width + MEMBERS_INSET }}>
          <TabChip tabId={shownTab} width={chip} tuck={tuck} dragged={false} hover={hover} />
        </View>
      )}
    </View>
  );
}

const FOLDER_MEASURE = { position: "absolute", left: 0, top: 0, width: 10000, flexDirection: "row", alignItems: "flex-start", opacity: 0 } as const;

export function FolderMeasures({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={FOLDER_MEASURE}>
      {ids.map((id) => (
        <FolderMeasure key={id} groupId={id} />
      ))}
    </View>
  );
}

function FolderMeasure({ groupId }: { groupId: string }) {
  const theme = useTheme();
  const group = useGroup(groupId, (g) => g);
  const label = useGroupLabel(groupId);
  if (!group) return null;
  return (
    <View onLayout={(e) => setMeasuredWidth(folderKey(groupId), Math.ceil(e.nativeEvent.layout.width * 2) / 2)}>
      <FolderFace icon={group.icon} color={group.color} label={label} ink={theme.textTab} border={ink.clear} fill={ink.clear} />
    </View>
  );
}

function FolderFace({ icon, color, label, ink: titleInk, border, fill }: { icon: string | null; color: GroupColor | null | undefined; label: string; ink: string; border: string; fill: string }) {
  return (
    <View
      style={{
        height: FOLDER_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: FOLDER_PAD.left,
        paddingRight: FOLDER_PAD.right,
        borderRadius: folderRadius(),
        borderWidth: CHIP_HAIRLINE,
        borderColor: border,
        backgroundColor: fill,
      }}
    >
      <StripGroupIcon icon={icon} color={color} open={false} />
      <Text numberOfLines={1} style={{ marginLeft: FOLDER_TITLE_GAP, maxWidth: FOLDER_TITLE_MAX, ...font.small, fontWeight: weight.semibold, color: titleInk }}>
        {label}
      </Text>
      <Symbol name="chevron.down" size={8} weight="semibold" color={withAlpha(titleInk, 0.6)} style={{ marginLeft: space.xs, width: 9, height: 9 }} />
    </View>
  );
}

function FolderChip({ groupId, holding }: { groupId: string; holding: boolean }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const windowId = useWindowId();
  const group = useGroup(groupId, (g) => g);
  const label = useGroupLabel(groupId);
  const hover = useChipHover();
  const hovered = useChipHovered(hover);
  const tip = useTooltip(`${label}\nShow Folder`);
  if (!group) return null;
  const tint = groupTint(group.color);
  const bare = group.color === "none";
  const titleInk = holding ? theme.textPrimary : theme.textTab;
  return (
    <View {...hover.hoverProps} mouseDownCanMoveWindow={false} tooltip={tip} style={{ position: "absolute", left: 0, top: MID - FOLDER_HEIGHT / 2, height: FOLDER_HEIGHT }}>
      <ContextMenuArea onContextMenu={() => void openGroupMenu(windowId, groupId)}>
        <Pressable onPress={() => void openFolderMenu(windowId, groupId)}>
          {({ pressed }) => (
            <FolderFace
              icon={group.icon}
              color={group.color}
              label={label}
              ink={titleInk}
              border={bare ? ink.clear : theme.pinnedRestingStroke}
              fill={pressed ? theme.tabPressed : tint ? withAlpha(tint, hovered ? 0.3 : 0.22) : hovered ? tokens.groupHeaderHover : bare ? ink.clear : tokens.groupFill}
            />
          )}
        </Pressable>
      </ContextMenuArea>
    </View>
  );
}

export function StripGroupIcon({ icon, color, open }: { icon: string | null; color: GroupColor | null | undefined; open: boolean }) {
  const theme = useTheme();
  if (!hasOwnGroupIcon(icon)) return <AnimatedFolder open={open} color={color} size={STRIP_FOLDER_SIDE} />;
  const symbol = iconSymbol(icon);
  if (symbol) return <Symbol name={symbol} size={11} weight="medium" color={groupTint(color) ?? theme.icon} style={{ width: 13, height: 13 }} />;
  return <TabIcon url="" icon={icon} />;
}
