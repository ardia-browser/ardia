import { useEffect, useRef } from "react";
import { Animated, StyleSheet } from "react-native";
import { Badge, FadeLabel, Panel, radius, space } from "../ui";
import { useTheme } from "../ui/theme";
import { useLive } from "../../state/live/store";
import { useGroup, useTab } from "../../state/browser/hooks";
import { useDragGhostLabel } from "../../state/sidebar/hooks";
import { useTabDrag } from "../../state/drag/tabDrag";
import type { Ghost } from "./dragModel";
import { FolderOrIcon } from "./AnimatedFolder";
import { FolderMosaic } from "./FolderTile";
import { TabIcon } from "./TabIcon";
import { GHOST_OVER_PROFILES, GHOST_ROW_POINTER, GHOST_TILE_MORPH, SIDEBAR_SHADOW, SIDEBAR_TYPE, TAB_ROW, useSidebarTokens } from "./tokens";
import { spring } from "../ui/motion";
import { useDropRow, useDropTile, useOverProfiles } from "./DragProvider";
import type { GhostShapeMark } from "../../state/sidebar/dragMarks";
import { folderOf } from "./dragModel";
import { ghostIcon, ghostTileIcon } from "../../state/pins/rowIcons";

export function DragGhost({ ghost }: { ghost: Ghost }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const { item, count, width, height, grab, position } = ghost;
  const tab = useTab(item.tabIds[0] ?? "");
  const liveFolderId = item.kind === "live" ? item.liveFolderId : undefined;
  const groupId = item.kind === "group" ? item.groupId : undefined;
  const folder = useLive((s) => (liveFolderId ? s.folders[liveFolderId] : undefined));
  const groupIcon = useGroup(groupId ?? null, (g) => g?.icon ?? null);
  const groupColor = useGroup(groupId ?? null, (g) => g?.color ?? null);
  const label = useDragGhostLabel(folder?.name, groupId, tab);
  const tile = item.kind === "tile";
  const folderTile = !!folderOf(item);
  const drawn = folderTile || groupId ? null : ghostIcon(tab, item.kind === "row");
  const tileDrawn = folderTile || groupId ? null : ghostTileIcon(tab);
  const textOnly = item.kind === "row" && !drawn;
  const onPage = useTabDrag((d) => d.phase === "tab" && d.onPage);
  const overProfiles = useOverProfiles();
  const tileTarget = useDropTile();
  const rowTarget = useDropRow();
  const morphs = item.kind === "row" || (tile && !folderTile);
  const target = !morphs || ghost.landing ? null : tile ? rowTarget : tileTarget;
  const { morph, shape } = useShapeMorph(target);
  const anchor = shape && { x: tile ? shape.w * GHOST_ROW_POINTER : shape.w / 2, y: shape.h / 2 };
  const toward = (from: number, to: number) => (shape ? morph.interpolate({ inputRange: [0, 1], outputRange: [from, to] }) : from);
  const away = shape ? morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) : 1;
  const tileShown = tile ? away : shape ? morph : 0;
  const rowShown = tile ? (shape ? morph : 0) : away;
  const tileNow = tile ? !target : !!target;
  const icon = drawn ? <TabIcon url={tab?.url ?? ""} favicon={tab?.favicon} icon={drawn.icon} profileId={tab?.profileId} /> : null;
  const tileIcon = tileDrawn ? <TabIcon url={tab?.url ?? ""} favicon={tab?.favicon} icon={tileDrawn.icon} profileId={tab?.profileId} /> : null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: toward(width, shape?.w ?? width),
        height: toward(height, shape?.h ?? height),
        opacity: onPage ? 0 : overProfiles ? GHOST_OVER_PROFILES : 1,
        transform: [...position.getTranslateTransform(), { translateX: toward(0, grab.x - (anchor?.x ?? 0)) }, { translateY: toward(0, grab.y - (anchor?.y ?? 0)) }],
      }}
    >
      <Panel
        fill={tokens.dragGhostFill}
        radius={tileNow ? radius.pinned : radius.chrome}
        border={tokens.dragGhostBorder}
        shadow={SIDEBAR_SHADOW.dragGhost}
        style={{
          ...StyleSheet.absoluteFillObject,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: folderTile ? "center" : "flex-start",
          paddingLeft: folderTile ? 0 : textOnly ? TAB_ROW.contentLeft - TAB_ROW.titleGap : TAB_ROW.contentLeft,
          paddingRight: TAB_ROW.trailing,
        }}
      >
        {tile || shape ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius.pinned, backgroundColor: tokens.dragGhostTileLift, opacity: tileShown }]} /> : null}
        {folder ? <FolderOrIcon icon={folder.icon} open={false} color={folder.color} /> : null}
        {groupId ? <FolderOrIcon icon={groupIcon} open={false} color={groupColor} /> : null}
        {folderTile ? <FolderMosaic tabIds={item.tabIds} width={width - TAB_ROW.trailing} /> : null}
        {!folderTile && (!tile || shape) ? (
          <Animated.View style={{ flex: 1, flexDirection: "row", alignItems: "center", opacity: rowShown }}>
            {icon}
            <FadeLabel text={label} fontSize={SIDEBAR_TYPE.title} weight={item.kind === "group" || item.kind === "live" ? "medium" : "regular"} color={theme.textPrimary} style={{ flex: 1, height: TAB_ROW.titleHeight, marginLeft: textOnly ? TAB_ROW.titleGap : space.m }} />
          </Animated.View>
        ) : null}
        {tileIcon && (tile || shape) ? <Animated.View style={[TILE_ICON, { opacity: tileShown }]}>{tileIcon}</Animated.View> : null}
      </Panel>
      {count > 1 && !folderTile ? (
        <Badge text={count} tone="accent" size="m" style={COUNT_BADGE} />
      ) : null}
    </Animated.View>
  );
}

const COUNT_BADGE = { position: "absolute", top: -6, right: -4 } as const;
const TILE_ICON = { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" } as const;

function useShapeMorph(target: GhostShapeMark | null) {
  const morph = useRef(new Animated.Value(0)).current;
  const last = useRef<GhostShapeMark | null>(null);
  if (target) last.current = target;
  const on = !!target;
  useEffect(() => {
    const motion = Animated.spring(morph, { toValue: on ? 1 : 0, ...spring(GHOST_TILE_MORPH), restDisplacementThreshold: 0.001, restSpeedThreshold: 0.01, useNativeDriver: false });
    motion.start();
    return () => motion.stop();
  }, [morph, on]);
  return { morph, shape: last.current };
}
