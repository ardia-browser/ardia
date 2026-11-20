import { Animated, StyleSheet, View } from "react-native";
import { ProfileSwipeArea } from "../window/ProfileSwipe";
import { useTheme } from "../ui/theme";
import { LibraryPanel } from "./LibraryPanel";
import { useLibraryLead } from "./useLibraryMorph";
import { useLibraryLayout } from "./useLibraryLayout";

export function LibraryLayer({
  windowId,
  sidebarWidth,
  width,
  onClip,
  onContent,
  right,
  style,
}: {
  windowId: string;
  sidebarWidth: number;
  width: Animated.AnimatedNode | undefined;
  onClip: (view: unknown) => void;
  onContent: (view: unknown) => void;
  right: boolean;
  style: { opacity: Animated.AnimatedInterpolation<number>; transform: { translateX: Animated.AnimatedInterpolation<number> }[] };
}) {
  const theme = useTheme();
  const { open } = useLibraryLead(windowId);
  const { rail, panel } = useLibraryLayout(windowId);
  const edge = right ? "right" : "left";
  return (
    <Animated.View
      ref={onClip}
      collapsable={false}
      pointerEvents={open ? "auto" : "none"}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      accessibilityElementsHidden={!open}
      style={{ position: "absolute", top: 0, bottom: 0, [edge]: 0, ...(width === undefined ? null : { width }), overflow: "hidden" }}
    >
      <Animated.View ref={onContent} collapsable={false} style={[{ position: "absolute", top: 0, bottom: 0, [edge]: 0, width: rail + panel }, style]}>
        <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, [edge]: rail, [right ? "left" : "right"]: -panel, backgroundColor: theme.groupFill }} />
        <LibraryPanel windowId={windowId} right={right} />
      </Animated.View>
      <ProfileSwipeArea surface="library" style={StyleSheet.absoluteFill} pageWidth={sidebarWidth} />
    </Animated.View>
  );
}
