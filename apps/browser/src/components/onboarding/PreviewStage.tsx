import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { Panel } from "../ui";
import { curve } from "../ui/motion";
import { radius } from "../ui/tokens";
import { ALL_QUESTION_KEYS } from "../../state/onboarding/questions";
import { useOnboarding } from "../../state/onboarding/onboarding";
import { MockPanel, useScreen } from "./Screen";
import { FittedPreview } from "./StepLayout";
import { useOnboardingColors } from "./Parts";
import { MockFocusContext, useFlowShown, useMockFocusValue } from "./sectionContext";
import { onboardingFlow, onboardingMotion, onboardingPane } from "./tokens";
import { useSceneDirector } from "./previews";
import { devRegister } from "../dev/devRegister";

const SWAP = { duration: onboardingMotion.previewSwap, easing: curve.enter, useNativeDriver: true, isInteraction: false } as const;
const LAYER_RISE = 0.98;

type Layer = { key: string; live: boolean };

export function PreviewStage() {
  const colors = useOnboardingColors();
  const shown = useFlowShown();
  const overlayKey = shown?.preview ? shown.key : null;
  const nodes = useRef<Record<string, ReactNode>>({});
  if (overlayKey) nodes.current[overlayKey] = shown!.preview;
  const [layers, setLayers] = useState<Layer[]>([]);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const mockShown = useRef(new Animated.Value(1)).current;

  useLayoutEffect(() => {
    setLayers((prev) => {
      const kept = prev.map((l) => ({ ...l, live: l.key === overlayKey }));
      return overlayKey && !kept.some((l) => l.key === overlayKey) ? [...kept, { key: overlayKey, live: true }] : kept;
    });
  }, [overlayKey]);

  useEffect(() => {
    const run = Animated.timing(mockShown, { toValue: overlayKey ? 0 : 1, ...SWAP });
    run.start();
    return () => run.stop();
  }, [!!overlayKey]);

  const gone = (key: string) => {
    delete nodes.current[key];
    setLayers((prev) => prev.filter((l) => l.key !== key || l.live));
  };

  return (
    <Panel
      fill={colors.stage}
      radius={radius.sheet}
      border={colors.tileBorder}
      shadow={onboardingPane.shadow}
      style={{ flex: 1, margin: onboardingFlow.paneMargin, marginLeft: 0 }}
      onLayout={(e) => setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
    >
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius.sheet, overflow: "hidden" }]}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", opacity: mockShown }]}>
          {box ? <LiveMock box={box} covered={!!overlayKey} /> : null}
        </Animated.View>
        {layers.map((l) => (
          <OverlayLayer key={l.key} live={l.live} onGone={() => gone(l.key)}>
            {l.live ? shown?.preview : nodes.current[l.key]}
          </OverlayLayer>
        ))}
      </View>
    </Panel>
  );
}

function LiveMock({ box, covered }: { box: { width: number; height: number }; covered: boolean }) {
  const { mock } = useScreen(ALL_QUESTION_KEYS);
  const store = useContext(MockFocusContext);
  const focus = useMockFocusValue();
  useEffect(() => devRegister("acOnboardingFocus", null, store), [store]);
  const group = useOnboarding((s) => `${s.step}.${s.sub}`);
  const shown = useSceneDirector(covered ? null : focus, mock, group, onboardingMotion.sectionScroll);
  const room = { width: box.width - onboardingFlow.panePad * 2, height: box.height - onboardingFlow.panePad * 2 };
  const width = Math.max(0, Math.min(onboardingFlow.mockMaxWidth, room.width, room.height * onboardingFlow.mockAspect));
  return <MockPanel settings={shown.settings} focus={shown.scene} size={{ width, height: width / onboardingFlow.mockAspect }} />;
}

function OverlayLayer({ live, onGone, children }: { live: boolean; onGone: () => void; children: ReactNode }) {
  const t = useRef(new Animated.Value(0)).current;
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    const run = Animated.timing(t, { toValue: live ? 1 : 0, ...SWAP });
    run.start(({ finished }) => finished && !live && gone.current());
    return () => run.stop();
  }, [live]);
  return (
    <Animated.View
      pointerEvents={live ? "box-none" : "none"}
      style={[StyleSheet.absoluteFill, { padding: onboardingFlow.panePad, opacity: t, transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [LAYER_RISE, 1] }) }] }]}
    >
      <View style={{ flex: 1 }} pointerEvents="box-none">
        <FittedPreview>{children}</FittedPreview>
      </View>
    </Animated.View>
  );
}
