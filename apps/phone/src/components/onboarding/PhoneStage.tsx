import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type ViewInstance } from "react-native";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { spring, useReduceMotion } from "../ui";
import { BlockingScreen } from "./BlockingScreen";
import { BlurStage } from "./BlurStage";
import { PhoneSlotContext, StepOwner, type PhoneScreenKind, type PhoneSlotApi, type PhoneSlotReport } from "./OnboardingKit";
import { onboardingMotion, phoneFrame, phoneStage } from "./onboardingTokens";
import { OpenLinkScreen } from "./OpenLinkScene";
import { PhoneFrame } from "./PhoneFrame";
import { frameTarget, phoneSize, sameSlot, scaledFromTopLeft } from "./phoneGeometry";
import { stageAround, SyncAbovePhone, SyncFlightProvider, SyncMac, SyncScreen, SyncStageBox } from "./SyncScene";
import { TipsReelProvider, TipsScreen } from "./TipsScenes";

const frameMove = spring(onboardingMotion.capsuleMove.response, onboardingMotion.capsuleMove.damping);

export const usePhoneStaged = () => useContext(PhoneSlotContext) !== null;

export function PhoneScreen({ screen }: { screen: PhoneScreenKind }) {
  if (screen === "blocking") return <BlockingScreen />;
  if (screen === "openLink") return <OpenLinkScreen />;
  if (screen === "sync") return <SyncScreen />;
  return <TipsScreen />;
}

export function PhoneSlot({ screen, scale, onPress, testID }: { screen: PhoneScreenKind; scale: number; onPress?: () => void; testID?: string }) {
  const slot = useContext(PhoneSlotContext);
  const owner = useContext(StepOwner);
  const frame = useRef<ViewInstance>(null);
  const size = phoneSize(scale);
  const body = slot ? (
    <View
      ref={frame}
      testID="phoneSlot"
      collapsable={false}
      style={size}
      onLayout={() => {
        if (owner) frame.current?.measureInWindow((x, y, width, height) => slot.report(owner, { screen, rect: { x, y, width, height } }));
      }}
    />
  ) : (
    <View style={size}>
      <PhoneFrame style={[styles.placed, { transform: scaledFromTopLeft(phoneFrame.width, phoneFrame.height, scale) }]}>
        <PhoneScreen screen={screen} />
      </PhoneFrame>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable testID={testID} onPress={onPress} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {body}
    </Pressable>
  );
}

type ShownStep = { step: string; closing: boolean };

export function PhoneStage({ step, steps, children }: { step: string; steps: readonly ShownStep[]; children: ReactNode }) {
  const live = useRef(step);
  live.current = step;
  const [slots, setSlots] = useState<Partial<Record<string, PhoneSlotReport>>>({});
  const api = useMemo<PhoneSlotApi>(
    () => ({
      report: (owner, slot) => {
        if (owner !== live.current) return;
        setSlots((now) => (sameSlot(now[owner], slot) ? now : { ...now, [owner]: slot }));
      },
    }),
    [],
  );
  const sync = slots.sync;
  const syncShown = steps.find((shown) => shown.step === "sync");
  const syncLayer = (layer: ReactNode, testID: string) =>
    sync && syncShown ? (
      <View key={testID} testID={testID} pointerEvents="none" style={styles.layer}>
        <BlurStage leaving={syncShown.closing}>
          <SyncStageBox {...stageAround(sync.rect)}>{layer}</SyncStageBox>
        </BlurStage>
      </View>
    ) : null;
  return (
    <SyncFlightProvider active={!!syncShown}>
      <TipsReelProvider active={steps.some((shown) => shown.step === "allSet")}>
        {syncLayer(<SyncMac />, "phoneStageBehind")}
        <StagedPhone slot={slots[step] ?? null} />
        {syncLayer(<SyncAbovePhone />, "phoneStageAbove")}
        <PhoneSlotContext.Provider value={api}>{children}</PhoneSlotContext.Provider>
      </TipsReelProvider>
    </SyncFlightProvider>
  );
}

function StagedPhone({ slot }: { slot: PhoneSlotReport | null }) {
  const reduceMotion = useReduceMotion();
  const centerX = useSharedValue(0);
  const centerY = useSharedValue(0);
  const scale = useSharedValue(1);
  const shown = useSharedValue(0);
  const placed = useRef(false);
  const lastScreen = useRef<PhoneScreenKind | null>(null);
  const [screen, setScreen] = useState<PhoneScreenKind | null>(slot?.screen ?? null);
  if (slot && slot.screen !== screen) setScreen(slot.screen);
  const visible = slot !== null;

  useEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => {
      placed.current = false;
      shown.value = withTiming(0, { duration: phoneStage.vanishMs });
    }, phoneStage.vanishGraceMs);
    return () => clearTimeout(timer);
  }, [visible, shown]);

  useEffect(() => {
    if (!slot) return;
    const target = frameTarget(slot.rect);
    const changedScreen = lastScreen.current !== slot.screen;
    lastScreen.current = slot.screen;
    if (!placed.current) {
      placed.current = true;
      centerX.value = target.centerX;
      centerY.value = target.centerY;
      scale.value = target.scale;
      shown.value = withDelay(reduceMotion ? 0 : phoneStage.appearDelayMs, withTiming(1, { duration: phoneStage.appearMs }));
      return;
    }
    if (reduceMotion) {
      const jump = (value: number) => (changedScreen ? withDelay(phoneStage.reducedOutMs, withTiming(value, { duration: 0 })) : value);
      if (changedScreen) shown.value = withSequence(withTiming(0, { duration: phoneStage.reducedOutMs }), withTiming(1, { duration: phoneStage.reducedInMs }));
      centerX.value = jump(target.centerX);
      centerY.value = jump(target.centerY);
      scale.value = jump(target.scale);
      return;
    }
    const to = (value: number) => withDelay(onboardingMotion.capsuleMoveDelayMs, withSpring(value, frameMove));
    centerX.value = to(target.centerX);
    centerY.value = to(target.centerY);
    scale.value = to(target.scale);
  }, [slot, reduceMotion, centerX, centerY, scale, shown]);

  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateX: centerX.value - phoneFrame.width / 2 }, { translateY: centerY.value - phoneFrame.height / 2 }, { scale: scale.value }],
  }));
  const fadeIn = FadeIn.duration(reduceMotion ? phoneStage.reducedInMs : phoneStage.screenInMs);
  const fadeOut = FadeOut.duration(reduceMotion ? phoneStage.reducedOutMs : phoneStage.screenOutMs);
  return (
    <Animated.View testID="phoneStage" pointerEvents="none" style={[styles.frame, style]}>
      <PhoneFrame>
        {screen ? (
          <Animated.View key={screen} entering={fadeIn} exiting={fadeOut} style={StyleSheet.absoluteFill}>
            <PhoneScreen screen={screen} />
          </Animated.View>
        ) : null}
      </PhoneFrame>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  placed: { position: "absolute", left: 0, top: 0 },
  layer: { ...StyleSheet.absoluteFill, zIndex: phoneStage.layer },
  frame: { position: "absolute", left: 0, top: 0, zIndex: phoneStage.layer },
});
