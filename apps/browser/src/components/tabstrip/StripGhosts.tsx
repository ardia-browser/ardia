import { memo, useContext, useLayoutEffect, useMemo, useReducer } from "react";
import { View } from "react-native";
import { FadeLabel } from "../ui";
import { useTheme } from "../ui/theme";
import { font } from "../ui/tokens";
import { useAnimatedStyle } from "../sidebar/EntryMotion";
import { TabIcon } from "../sidebar/TabIcon";
import { StripMotionContext, type StripGhost, type StripMotion } from "./stripMotion";
import { CHIP_LABEL_GAP, CHIP_PAD, ITEM_HEIGHT, ITEM_TOP, TOP_STRIP_HEIGHT } from "./tokens";

export const StripGhosts = memo(function StripGhosts() {
  const motion = useContext(StripMotionContext);
  const [, changed] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => motion?.watchGhosts(changed), [motion]);
  const ghosts = motion?.ghosts() ?? [];
  return (
    <View pointerEvents="none" style={GHOST_LAYER}>
      {motion ? ghosts.map((g) => <GhostChip key={g.key} ghost={g} motion={motion} />) : null}
    </View>
  );
});

const GHOST_LAYER = { position: "absolute", left: 0, right: 0, top: 0, height: TOP_STRIP_HEIGHT } as const;

const GhostChip = memo(function GhostChip({ ghost, motion }: { ghost: StripGhost; motion: StripMotion }) {
  const theme = useTheme();
  const style = useMemo(() => ({ opacity: ghost.opacity }), [ghost]);
  const [faded, ref] = useAnimatedStyle(style);
  useLayoutEffect(() => motion.fade(ghost), [motion, ghost]);
  const { tab } = ghost;
  return (
    <View {...faded} ref={ref} style={[{ position: "absolute", left: ghost.x, top: ITEM_TOP, width: ghost.width, height: ITEM_HEIGHT, flexDirection: "row", alignItems: "center", paddingLeft: CHIP_PAD.left, paddingRight: CHIP_PAD.right }, faded.style as object]}>
      <TabIcon url={tab.url} favicon={tab.favicon} icon={tab.icon} profileId={tab.profileId} />
      <FadeLabel text={tab.title} fontSize={font.small.fontSize} color={theme.textTab} style={{ flex: 1, height: 16, marginLeft: CHIP_LABEL_GAP }} />
    </View>
  );
});
