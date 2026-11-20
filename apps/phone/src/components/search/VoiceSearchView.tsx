import { useEffect, useRef } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type ViewInstance } from "react-native";
import Animated, { Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../lib/platformCopy";
import { PROBLEM_TEXT, voiceControl, type Dictation } from "../../state/voice/dictation";
import { browseSpoken, closeVoiceSearch, openSpeechSettings, searchSpoken, startListening, stopListening, useDictation, useVoiceLevels, useVoicePresented } from "../../state/voice/store";
import { browseForMeOffered } from "../../state/browseForMe/offer";
import { ArdiaLogo, capsule, font, FrostSource, LookBackdrop, LookFrost, space, Symbol, useCoverFocus, voiceInk, voiceLayout, type SymbolName, useReduceMotion } from "../ui";

export function VoiceSearchView() {
  const presented = useVoicePresented();
  return presented ? <VoiceCover /> : null;
}

function VoiceCover() {
  const insets = useSafeAreaInsets();
  const dictation = useDictation();
  const cancel = useRef<ViewInstance>(null);
  useCoverFocus(cancel);
  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <FrostSource name={VOICE_FROST} style={StyleSheet.absoluteFill} pointerEvents="none">
        <LookBackdrop dark />
      </FrostSource>
      <View style={[styles.column, { paddingTop: insets.top, paddingBottom: insets.bottom + space.xl, paddingLeft: insets.left + space.xl, paddingRight: insets.right + space.xl }]}>
        <View style={styles.fill} />
        <LevelLogo level={dictation.level} />
        <Transcript dictation={dictation} />
        <View style={styles.fill} />
        <Waveform listening={dictation.phase === "listening"} />
        <Controls dictation={dictation} />
      </View>
      <Pressable
        ref={cancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        onPress={closeVoiceSearch}
        style={[styles.cancel, { top: insets.top + space.s, right: insets.right + space.l }]}
      >
        <LookFrost source={VOICE_FROST} variant="glass" dark cornerRadius={capsule(voiceLayout.cancel)} fill={voiceInk.glass} style={styles.cancelFace}>
          <Symbol name="xmark" size={voiceLayout.icon} color={voiceInk.label} />
        </LookFrost>
      </Pressable>
    </View>
  );
}

function LevelLogo({ level }: { level: number }) {
  const reduceMotion = useReduceMotion();
  const shown = useSharedValue(level);
  useEffect(() => {
    shown.value = withTiming(level, { duration: voiceLayout.levelMotion, easing: Easing.out(Easing.quad) });
  }, [level]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: reduceMotion ? 1 : 0.92 + shown.value * 0.16 }] }));
  return (
    <Animated.View style={[styles.logo, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <ArdiaLogo width={voiceLayout.logo} />
    </Animated.View>
  );
}

function Transcript({ dictation }: { dictation: Dictation }) {
  if (dictation.phase === "denied") {
    return (
      <View style={styles.message}>
        <Text style={[font.title3, styles.bold, styles.centered, { color: voiceInk.label }]}>Speech and Mic permissions required.</Text>
        <Text style={[font.subheadline, styles.centered, { color: voiceInk.soft }]}>{copy().voicePermission}</Text>
        <GlassPill title="Open Settings" onPress={openSpeechSettings} />
      </View>
    );
  }
  if (dictation.phase === "unavailable" && dictation.problem) {
    return <Text style={[font.title3, styles.bold, styles.centered, { color: voiceInk.label }]}>{PROBLEM_TEXT[dictation.problem]}</Text>;
  }
  const empty = !dictation.transcript;
  return (
    <Animated.View key={dictation.transcript} entering={TRANSCRIPT_IN} exiting={TRANSCRIPT_OUT}>
      <Text
        accessibilityLiveRegion="polite"
        style={[font.title2, styles.bold, styles.centered, styles.transcript, { color: empty ? voiceInk.quiet : voiceInk.label }]}
      >
        {empty ? "Listening…" : dictation.transcript}
      </Text>
    </Animated.View>
  );
}

function Waveform({ listening }: { listening: boolean }) {
  const levels = useVoiceLevels();
  return (
    <View style={[styles.wave, { opacity: listening ? 1 : 0 }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {levels.map((level, index) => (
        <WaveBar key={index} height={Math.min(voiceLayout.waveHeight, voiceLayout.barMin + level * voiceLayout.barRange)} />
      ))}
    </View>
  );
}

const TRANSCRIPT_IN = FadeIn.duration(150);
const TRANSCRIPT_OUT = FadeOut.duration(150);
const WAVE_EASE_MS = 100;

function WaveBar({ height }: { height: number }) {
  const shown = useSharedValue(height);
  useEffect(() => {
    shown.value = Platform.OS === "ios" ? withTiming(height, { duration: WAVE_EASE_MS, easing: Easing.out(Easing.quad) }) : height;
  }, [height]);
  const style = useAnimatedStyle(() => ({ height: shown.value }));
  return <Animated.View style={[styles.bar, style]} />;
}

function Controls({ dictation }: { dictation: Dictation }) {
  const control = voiceControl(dictation);
  return (
    <View style={styles.controls}>
      {control?.kind === "done" ? <GlassPill title="Done" icon="stopFill" onPress={stopListening} /> : null}
      {control?.kind === "search" ? <GlassPill title="Search" onPress={() => searchSpoken(control.text)} /> : null}
      {control?.kind === "search" && browseForMeOffered() ? <GlassPill title="Browse for Me" icon="sparkleMagnifyingglass" onPress={() => browseSpoken(control.text)} /> : null}
      {control?.kind === "tryAgain" ? <GlassPill title="Try Again" icon="micFill" onPress={() => void startListening()} /> : null}
    </View>
  );
}

function GlassPill({ title, icon, onPress }: { title: string; icon?: SymbolName; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={styles.pillHit}>
      <LookFrost source={VOICE_FROST} variant="glass" dark cornerRadius={capsule(voiceLayout.pill)} fill={voiceInk.glass} style={styles.pill}>
        {icon ? <Symbol name={icon} size={voiceLayout.icon} color={voiceInk.label} /> : null}
        <Text style={[font.body, styles.medium, { color: voiceInk.label }]}>{title}</Text>
      </LookFrost>
    </Pressable>
  );
}

const VOICE_FROST = "voice";

const styles = StyleSheet.create({
  column: { flex: 1, alignItems: "center", gap: space.huge },
  fill: { flex: 1 },
  bold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  centered: { textAlign: "center" },
  logo: {
    width: voiceLayout.logo,
    height: voiceLayout.logo,
    borderRadius: voiceLayout.logo / 2,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0px 6px 12px rgba(0, 0, 0, 0.15)",
  },
  message: { alignItems: "center", gap: space.m, alignSelf: "stretch" },
  transcript: { backgroundColor: voiceInk.transcript, borderRadius: voiceLayout.transcriptRadius, paddingHorizontal: space.xl, paddingVertical: space.m, overflow: "hidden" },
  wave: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: voiceLayout.barGap, height: voiceLayout.waveHeight, alignSelf: "stretch" },
  bar: { width: voiceLayout.bar, borderRadius: voiceLayout.bar / 2, backgroundColor: voiceInk.bar },
  controls: { alignSelf: "stretch", minHeight: voiceLayout.pill, gap: space.m },
  pillHit: { alignSelf: "stretch" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s,
    minHeight: voiceLayout.pill,
    paddingHorizontal: space.xl,
  },
  cancel: {
    position: "absolute",
    width: voiceLayout.cancel,
    height: voiceLayout.cancel,
  },
  cancelFace: { flex: 1, alignItems: "center", justifyContent: "center" },
});
