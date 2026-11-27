import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { withAlpha } from "../../lib/color";
import { font, space, tabsMotion } from "../ui";
import { blockingDemo } from "./blockingDemoTokens";
import { openLink, phoneFrame, textHalo, tipsReel } from "./onboardingTokens";
import { PhoneSlot, usePhoneStaged } from "./PhoneStage";
import { fitPhoneScale } from "./phoneGeometry";
import { flightScale, PHONE_IN_STAGE, SyncAbovePhone, SyncFlightProvider, SyncMac, SyncStageBox, useSyncFlight } from "./SyncScene";
import { syncFlight } from "./syncFlightTokens";
import { REEL_TIPS, TipsReelProvider, useTipsReel } from "./TipsScenes";

const CAPTION_BLOCK = tipsReel.captionGap + tipsReel.captionHeight + tipsReel.dotsGap + tipsReel.dot.height;

export const demoScale = (width: number, height: number) => fitPhoneScale(width, height, blockingDemo);

export const openLinkScale = (width: number, height: number) => fitPhoneScale(width, height, openLink);

export const reelScale = (height: number) => Math.min(tipsReel.maxScale, Math.max(tipsReel.minScale, (height - CAPTION_BLOCK) / phoneFrame.height));

function useMeasured<T>(fit: (width: number, height: number) => T) {
  const [fitted, setFitted] = useState<T | null>(null);
  const measure = (event: LayoutChangeEvent) => setFitted(fit(event.nativeEvent.layout.width, event.nativeEvent.layout.height));
  return { fitted, measure };
}

function FittedArt({ testID, measure, measured, children }: { testID: string; measure: (event: LayoutChangeEvent) => void; measured: boolean; children: ReactNode }) {
  return (
    <View testID={testID} onLayout={measure} style={[styles.fill, { opacity: measured ? 1 : 0 }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {children}
    </View>
  );
}

export function BlockingDemo() {
  const { fitted, measure } = useMeasured(demoScale);
  return (
    <FittedArt testID="blockingDemo" measure={measure} measured={fitted !== null}>
      {fitted !== null ? <PhoneSlot screen="blocking" scale={fitted} /> : null}
    </FittedArt>
  );
}

export function OpenLinkDemo() {
  const { fitted, measure } = useMeasured(openLinkScale);
  return (
    <FittedArt testID="openLinkDemo" measure={measure} measured={fitted !== null}>
      {fitted !== null ? <PhoneSlot screen="openLink" scale={fitted} /> : null}
    </FittedArt>
  );
}

export function SyncFlight() {
  const shared = useSyncFlight();
  if (shared) return <SyncFlightArt />;
  return (
    <SyncFlightProvider active>
      <SyncFlightArt />
    </SyncFlightProvider>
  );
}

function SyncFlightArt() {
  const staged = usePhoneStaged();
  const { fitted, measure } = useMeasured(flightScale);
  const scale = fitted ?? 1;
  return (
    <FittedArt testID="syncFlight" measure={measure} measured={fitted !== null}>
      <View testID="syncFlightStage" style={{ width: syncFlight.stage.width * scale, height: syncFlight.stage.height * scale }}>
        {staged ? null : (
          <SyncStageBox x={0} y={0} scale={scale}>
            <SyncMac />
          </SyncStageBox>
        )}
        <View style={[styles.syncPhone, { left: PHONE_IN_STAGE.left * scale, top: PHONE_IN_STAGE.top * scale }]}>
          <PhoneSlot screen="sync" scale={PHONE_IN_STAGE.scale * scale} />
        </View>
        {staged ? null : (
          <SyncStageBox x={0} y={0} scale={scale}>
            <SyncAbovePhone />
          </SyncStageBox>
        )}
      </View>
    </FittedArt>
  );
}

export function TipsReel() {
  const shared = useTipsReel();
  if (shared) return <TipsReelArt />;
  return (
    <TipsReelProvider active>
      <TipsReelArt />
    </TipsReelProvider>
  );
}

function TipsReelArt() {
  const reel = useTipsReel()!;
  const { fitted, measure } = useMeasured((_, height) => reelScale(height));
  const fade = reel.reduceMotion ? tabsMotion.fade : tabsMotion.surfaceFade;
  return (
    <View testID="tipsReel" onLayout={measure} style={[styles.fill, { opacity: fitted === null ? 0 : 1 }]} accessible accessibilityLabel={REEL_TIPS.join(" ")}>
      <PhoneSlot screen="tips" scale={fitted ?? tipsReel.maxScale} onPress={reel.next} testID="tipsReelStage" />
      <Animated.Text key={`caption${reel.scene}`} testID="tipsReelCaption" entering={FadeIn.duration(fade)} exiting={FadeOut.duration(fade)} style={[font.body, styles.caption]} numberOfLines={1} adjustsFontSizeToFit>
        {REEL_TIPS[reel.scene]}
      </Animated.Text>
      <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {REEL_TIPS.map((tip, index) => (
          <Pressable key={tip} testID="tipsReelDot" hitSlop={tipsReel.dot.hitSlop} onPress={() => reel.jump(index)} style={styles.dot}>
            {index < reel.scene || (reel.reduceMotion && index === reel.scene) ? <View style={[styles.dotFill, styles.dotDone]} /> : index === reel.scene ? <DotFill clock={reel.clock} /> : null}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function DotFill({ clock }: { clock: SharedValue<number> }) {
  const fill = useAnimatedStyle(() => ({ width: `${clock.value * 100}%` }));
  return <Animated.View style={[styles.dotFill, fill]} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  syncPhone: { position: "absolute" },
  caption: { marginTop: tipsReel.captionGap, minHeight: tipsReel.captionHeight, textAlign: "center", fontWeight: "600", paddingHorizontal: space.l, color: tipsReel.captionInk, ...textHalo },
  dots: { flexDirection: "row", gap: tipsReel.dot.gap, marginTop: tipsReel.dotsGap },
  dot: { width: tipsReel.dot.width, height: tipsReel.dot.height, borderRadius: tipsReel.dot.height / 2, overflow: "hidden", backgroundColor: withAlpha(tipsReel.captionInk, 0.6) },
  dotFill: { height: "100%", borderRadius: tipsReel.dot.height / 2, backgroundColor: tipsReel.captionInk },
  dotDone: { width: "100%" },
});
