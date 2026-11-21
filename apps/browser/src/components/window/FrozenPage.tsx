import { useEffect } from "react";
import { Image, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { useTheme } from "../ui/theme";
import { windowColors } from "./tokens";
import { useTab } from "../../state/browser/hooks";
import { activate } from "../../state/tabs/actions";
import { notePainted, startPinHandoff, useFrozenPages } from "../../state/pins/pinHandoff";

export function cornersOf(radius: number, top: number): ViewStyle {
  return top > 0 ? { borderBottomLeftRadius: radius, borderBottomRightRadius: radius } : { borderRadius: radius };
}

export function FrozenPage({ windowId, tabId, top, radius }: { windowId: string; tabId: string | undefined; top: number; radius: number }) {
  const theme = useTheme();
  useEffect(startPinHandoff, []);
  const frozen = useTab(tabId, (t) => t?.page.kind === "frozen");
  const pass = useFrozenPages((f) => f.bridges[windowId]);
  const copyId = frozen ? tabId : pass?.copyId;
  const uri = useFrozenPages((f) => (copyId ? f.frames[copyId] : undefined)) ?? pass?.uri;
  if (!frozen && !pass) return null;
  return (
    <Pressable
      accessibilityLabel="Bring this tab to this window"
      onPress={() => {
        if (frozen && tabId) activate(tabId);
      }}
      style={[StyleSheet.absoluteFill, { top, overflow: "hidden" }, cornersOf(radius, top)]}
    >
      {uri && <Image testID="ardia.pagePicture" source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" onLoad={() => notePainted(windowId)} />}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: windowColors(theme.dark).frozenWash }]} />
    </Pressable>
  );
}
