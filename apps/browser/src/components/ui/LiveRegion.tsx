import { Text, View } from "react-native";

export function LiveRegion({ text }: { text: string }) {
  return (
    <View accessibilityLiveRegion="polite" pointerEvents="none" style={LIVE_REGION}>
      <Text>{text}</Text>
    </View>
  );
}

const LIVE_REGION = { position: "absolute", left: -10000, top: 0, width: 1, height: 1, overflow: "hidden" } as const;
