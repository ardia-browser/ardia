import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialBottomBar, type MaterialPageBarProps } from "../ui/MaterialBottomBar";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialBottomBar } from "../ui/materialTokens";

export { tabCountLabel } from "../ui/MaterialBottomBar";

export function MaterialPageBar(props: MaterialPageBarProps) {
  const { scheme } = useMaterialTheme(props.tab.isPrivate);
  return <MaterialBottomBar isTabOverview={false} {...props} scheme={scheme} container={{ testID: "materialPageBar" }} />;
}

export function MaterialBarBand({ safeSide, ...bar }: MaterialPageBarProps & { safeSide: number }) {
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.band, { bottom: insets.bottom, paddingHorizontal: safeSide + materialBottomBar.edge }]}>
      <MaterialPageBar {...bar} />
    </View>
  );
}

const styles = StyleSheet.create({
  band: { position: "absolute", left: 0, right: 0, paddingVertical: materialBottomBar.inset },
});
