import { StyleSheet, View } from "react-native";
import type { MeadowProps } from "./index";
import { Meadow as Scene } from "./meadow.tsx";
import { Meadow as Poster } from "./meadow.windows.tsx";

export function Meadow({ night, onTone, style, testID }: MeadowProps) {
  return (
    <View pointerEvents="none" testID={testID} style={[style, { overflow: "hidden" }]}>
      <Poster night={night} style={StyleSheet.absoluteFill} />
      <Scene night={night} onTone={onTone} style={StyleSheet.absoluteFill} />
    </View>
  );
}
