import { useEffect, useMemo, useRef } from "react";
import { Animated, StyleSheet } from "react-native";
import { Badge, FadeLabel, hairline, Panel, radius, space } from "../ui";
import { hex, useTheme } from "../ui/theme";
import { useLive } from "../../state/live/store";
import { useGroup, useTab } from "../../state/browser/hooks";
import { useDragGhostLabel } from "../../state/sidebar/hooks";
import { useTabDrag } from "../../state/drag/tabDrag";
import type { Ghost } from "./dragModel";
import { FolderOrIcon } from "./AnimatedFolder";
import { FolderMosaic } from "./FolderTile";
import { TabIcon } from "./TabIcon";
import { GHOST_OPACITY, GHOST_OVER_PROFILES, GHOST_ROW_POINTER, GHOST_TILE_MORPH, SIDEBAR_SHADOW, SIDEBAR_TYPE, TAB_ROW, useSidebarTokens } from "./tokens";
import { spring } from "../ui/motion";
import { useDropPane, useDropRow, useDropTile, useOverProfiles } from "./DragProvider";
import { PANE_ROW, PanePreview } from "./SplitPreview";
import { profileSurfaces } from "./profileSurfaces";
import { folderOf } from "./dragModel";
import { ghostIcon, ghostTileIcon } from "../../state/pins/rowIcons";

export function DragGhost({ ghost }: { ghost: Ghost }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const surfaces = profileSurfaces(theme);
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
  const paneTarget = useDropPane();
  const other = tile ? rowTarget : tileTarget;
  const base: Look = { w: width, h: height, face: tile ? "tile" : "row", at: null, corner: tile ? radius.pinned : radius.chrome, shift: null };
  const anchored = (w: number, h: number) => ({ x: grab.x - (tile ? w * GHOST_ROW_POINTER : w / 2), y: grab.y - h / 2 });
  const look: Look =
    !morphs || ghost.landing
      ? base
      : paneTarget
        ? { w: paneTarget.w, h: paneTarget.h, face: "pane", at: { x: paneTarget.x, y: paneTarget.y }, corner: paneTarget.corner, shift: anchored(paneTarget.w, paneTarget.h) }
        : other
          ? { w: other.w, h: other.h, face: tile ? "row" : "tile", at: null, corner: tile ? radius.chrome : radius.pinned, shift: anchored(other.w, other.h) }
          : base;
  const m = useLookMorph(look, base, position);
  const transform = useMemo(
    () => [
      { translateX: Animated.add(Animated.multiply(Animated.add(position.x, m.shiftX), m.follow), Animated.multiply(m.slot.x, m.pin)) },
      { translateY: Animated.add(Animated.multiply(Animated.add(position.y, m.shiftY), m.follow), Animated.multiply(m.slot.y, m.pin)) },
    ],
    [position, m],
  );
  const fill = useMemo(() => m.paneShown.interpolate({ inputRange: [0, 1], outputRange: [surfaces.ghost, surfaces.activePanes.selected] }), [m, surfaces]);
  const lifted = useMemo(() => m.paneShown.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }), [m]);
  const icon = drawn ? <TabIcon url={tab?.url ?? ""} favicon={tab?.favicon} icon={drawn.icon} profileId={tab?.profileId} /> : null;
  const tileIcon = tileDrawn ? <TabIcon url={tab?.url ?? ""} favicon={tab?.favicon} icon={tileDrawn.icon} profileId={tab?.profileId} /> : null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: m.w,
        height: m.h,
        opacity: onPage ? 0 : overProfiles ? GHOST_OVER_PROFILES : 1,
        transform,
      }}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: lifted }]}>
        <Panel fill={surfaces.ghost} radius={look.face === "pane" ? base.corner : look.corner} border={null} shadow={SIDEBAR_SHADOW.dragGhost} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View
        style={{
          ...StyleSheet.absoluteFillObject,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: folderTile ? "center" : "flex-start",
          paddingLeft: folderTile ? 0 : textOnly ? TAB_ROW.contentLeft - TAB_ROW.titleGap : TAB_ROW.contentLeft,
          paddingRight: TAB_ROW.trailing,
          opacity: GHOST_OPACITY,
          borderRadius: m.corner,
          borderWidth: hairline.panel,
          borderColor: hex(tokens.dragBorder),
          backgroundColor: fill,
        }}
      >
        {folder ? <FolderOrIcon icon={folder.icon} open={false} color={folder.color} /> : null}
        {groupId ? <FolderOrIcon icon={groupIcon} open={false} color={groupColor} /> : null}
        {folderTile ? <FolderMosaic tabIds={item.tabIds} width={width - TAB_ROW.trailing} /> : null}
        {!folderTile && m.seen.has("row") ? (
          <Animated.View style={{ flex: 1, flexDirection: "row", alignItems: "center", opacity: m.rowShown }}>
            {icon}
            <FadeLabel text={label} fontSize={SIDEBAR_TYPE.title} weight={item.kind === "group" || item.kind === "live" ? "medium" : "regular"} color={surfaces.ghostText} style={{ flex: 1, height: TAB_ROW.titleHeight, marginLeft: textOnly ? TAB_ROW.titleGap : space.m }} />
          </Animated.View>
        ) : null}
        {tileIcon && m.seen.has("tile") ? <Animated.View style={[TILE_ICON, { opacity: m.tileShown }]}>{tileIcon}</Animated.View> : null}
        {tab && m.seen.has("pane") ? (
          <Animated.View style={[StyleSheet.absoluteFill, PANE_ROW, { opacity: m.paneShown }]}>
            <PanePreview tabId={tab.id} color={surfaces.ghostText} />
          </Animated.View>
        ) : null}
      </Animated.View>
      {count > 1 && !folderTile ? (
        <Badge text={count} tone="accent" size="m" style={COUNT_BADGE} />
      ) : null}
    </Animated.View>
  );
}

type Face = "row" | "tile" | "pane";
type Look = { w: number; h: number; face: Face; at: { x: number; y: number } | null; corner: number; shift: { x: number; y: number } | null };

const COUNT_BADGE = { position: "absolute", top: -6, right: -4 } as const;
const TILE_ICON = { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" } as const;

function useLookMorph(look: Look, base: Look, owner: Animated.ValueXY) {
  const motion = useRef<ReturnType<typeof lookValues> | null>(null);
  if (motion.current?.owner !== owner) motion.current = lookValues(base, owner);
  const m = motion.current;
  m.seen.add(look.face);
  const key = JSON.stringify(look);
  useEffect(() => {
    const go = (value: Animated.Value, toValue: number) =>
      Animated.spring(value, { toValue, ...spring(GHOST_TILE_MORPH), restDisplacementThreshold: 0.001, restSpeedThreshold: 0.01, useNativeDriver: false });
    const moves = [
      go(m.w, look.w),
      go(m.h, look.h),
      go(m.corner, look.corner),
      go(m.shiftX, look.shift?.x ?? 0),
      go(m.shiftY, look.shift?.y ?? 0),
      go(m.tileShown, look.face === "tile" ? 1 : 0),
      go(m.paneShown, look.face === "pane" ? 1 : 0),
    ];
    if (look.at && m.slotLive.current) moves.push(go(m.slot.x, look.at.x), go(m.slot.y, look.at.y));
    else if (look.at) m.slot.setValue(look.at);
    if (look.at) m.slotLive.current = true;
    const pinned = !!look.at;
    const pin = go(m.pin, pinned ? 1 : 0);
    pin.start(({ finished }) => {
      if (finished && !pinned) m.slotLive.current = false;
    });
    const all = Animated.parallel(moves, { stopTogether: false });
    all.start();
    return () => {
      all.stop();
      pin.stop();
    };
  }, [key, m]);
  return m;
}

function lookValues(base: Look, owner: Animated.ValueXY) {
  const pin = new Animated.Value(0);
  const tileShown = new Animated.Value(base.face === "tile" ? 1 : 0);
  const paneShown = new Animated.Value(0);
  return {
    w: new Animated.Value(base.w),
    h: new Animated.Value(base.h),
    corner: new Animated.Value(base.corner),
    shiftX: new Animated.Value(0),
    shiftY: new Animated.Value(0),
    slot: new Animated.ValueXY({ x: 0, y: 0 }),
    pin,
    follow: pin.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    tileShown,
    paneShown,
    rowShown: Animated.subtract(1, Animated.add(tileShown, paneShown)).interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: "clamp" }),
    seen: new Set<Face>([base.face]),
    slotLive: { current: false },
    owner,
  };
}
