import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Host, RNHostView, ZStack } from "@expo/ui/swift-ui";
import { animation, Animation, blur, onAppear, opacity } from "@expo/ui/swift-ui/modifiers";
import { useReduceMotion } from "../ui";
import { blurStage } from "./onboardingTokens";

export function BlurStage({ leaving, children }: { leaving: boolean; children: ReactNode }) {
  const reduceMotion = useReduceMotion();
  const [appeared, setAppeared] = useState(false);
  const shown = appeared && !leaving;
  const motion = shown
    ? Animation.easeOut({ duration: reduceMotion ? blurStage.reducedS : blurStage.inS }).delay(reduceMotion ? 0 : blurStage.inDelayS)
    : Animation.easeIn({ duration: reduceMotion ? blurStage.reducedS : blurStage.outS });
  return (
    <Host style={StyleSheet.absoluteFill} ignoreSafeArea="all">
      <ZStack modifiers={[blur(shown || reduceMotion ? 0 : blurStage.radius), opacity(shown ? 1 : 0), animation(motion, shown), onAppear(() => setAppeared(true))]}>
        <RNHostView>
          <View style={styles.fill}>{children}</View>
        </RNHostView>
      </ZStack>
    </Host>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
