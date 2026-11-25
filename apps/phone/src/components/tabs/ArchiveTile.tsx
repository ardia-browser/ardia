import { StyleSheet, View } from "react-native";
import { tileGradient } from "../../lib/favicon";
import { linearGradientCss } from "../../lib/gradient";
import { archiveCardLayout, ink, Symbol } from "../ui";

export function ArchiveTile({ side }: { side: number }) {
  return (
    <View style={[styles.tile, { width: side, height: side, borderRadius: side * 0.25, experimental_backgroundImage: linearGradientCss(tileGradient(archiveCardLayout.tint), false, side, side) }]}>
      <Symbol name="archivebox" size={side * 0.55} color={ink.white} />
    </View>
  );
}

const styles = StyleSheet.create({ tile: { alignItems: "center", justifyContent: "center" } });
