import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View, type ViewInstance } from "react-native";
import Animated, { Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../lib/platformCopy";
import { actionWords, dismissWords } from "../../lib/sharedWords";
import { PROBLEM_TEXT, voiceControl, type Dictation } from "../../state/voice/dictation";
import { browseSpoken, closeVoiceSearch, openSpeechSettings, presentVoiceSearch, searchSpoken, startListening, stopListening, useDictation, useVoiceLevels, useVoicePresented } from "../../state/voice/store";
import { browseForMeOffered } from "../../state/browseForMe/offer";
import { ActionButton, ArdiaLogo, font, FrostSource, LookBackdrop, motionAliases, smoothCorners, space, useModalOverlay, voiceInk, voiceLayout, useReduceMotion } from "../ui";
import { OverlayCancelButton } from "../ui/LookViews";
import type { FocusTarget } from "../ui/coverFocus";

let voiceOpener: FocusTarget | null = null;

export function presentVoiceSearchFrom(opener: FocusTarget) {
  voiceOpener = opener;
  if (!presentVoiceSearch()) voiceOpener = null;
}

const takeVoiceOpener = () => {
  const opener = voiceOpener;
  voiceOpener = null;
  return opener ?? undefined;
};

export function VoiceSearchView() {
  const presented = useVoicePresented();
  const [mounted, setMounted] = useState(presented);
  if (presented && !mounted) setMounted(true);
  useEffect(() => {
    if (!presented && mounted) setMounted(false);
  }, [presented, mounted]);
  return mounted ? <VoiceCover closing={!presented} /> : null;
}

function VoiceCover({ closing }: { closing: boolean }) {
  const insets = useSafeAreaInsets();
  const dictation = useDictation();
  const cancel = useRef<ViewInstance>(null);
  const [opener] = useState(takeVoiceOpener);
  const modal = useModalOverlay({ open: true, closing, onDismiss: closeVoiceSearch, focus: cancel, returnFocusTo: opener });
  return (
    <View testID="voiceCover" style={StyleSheet.absoluteFill} {...modal}>
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
      <OverlayCancelButton testID="voiceCancel" label={dismissWords.cancel} onPress={closeVoiceSearch} frostSource={VOICE_FROST} buttonRef={cancel} />
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
        <Text accessibilityRole="header" style={[font.title3, styles.bold, styles.centered, { color: voiceInk.label }]}>Speech and Mic permissions required.</Text>
        <Text style={[font.subheadline, styles.centered, { color: voiceInk.soft }]}>{copy().voicePermission}</Text>
        <ActionButton testID="voiceOpenSettings" title={actionWords.openSettings} tone="overlay" onPress={openSpeechSettings} stretch />
      </View>
    );
  }
  if (dictation.phase === "unavailable" && dictation.problem) {
    return (
      <Text accessibilityRole="header" style={[font.title3, styles.bold, styles.centered, { color: voiceInk.label }]}>
        {PROBLEM_TEXT[dictation.problem]}
      </Text>
    );
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

export const waveBarHeight = (level: number, reduceMotion: boolean) => (reduceMotion ? voiceLayout.barMin : Math.min(voiceLayout.waveHeight, voiceLayout.barMin + level * voiceLayout.barRange));

function Waveform({ listening }: { listening: boolean }) {
  const levels = useVoiceLevels();
  const reduceMotion = useReduceMotion();
  return (
    <View testID="voiceWave" style={[styles.wave, { opacity: listening ? 1 : 0 }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {levels.map((level, index) => (
        <WaveBar key={index} height={waveBarHeight(level, reduceMotion)} eases={!reduceMotion} />
      ))}
    </View>
  );
}

const TRANSCRIPT_IN = FadeIn.duration(motionAliases.voiceTranscriptFadeMs);
const TRANSCRIPT_OUT = FadeOut.duration(motionAliases.voiceTranscriptFadeMs);

function WaveBar({ height, eases }: { height: number; eases: boolean }) {
  const shown = useSharedValue(height);
  useEffect(() => {
    shown.value = eases ? withTiming(height, { duration: motionAliases.voiceWaveEaseMs, easing: Easing.out(Easing.quad) }) : height;
  }, [height, eases]);
  const style = useAnimatedStyle(() => ({ height: shown.value }));
  return <Animated.View testID="voiceWaveBar" style={[styles.bar, style]} />;
}

function Controls({ dictation }: { dictation: Dictation }) {
  const control = voiceControl(dictation);
  return (
    <View style={styles.controls}>
      {control?.kind === "done" ? <ActionButton testID="voiceDone" title={dismissWords.done} icon="stopFill" variant="glass" tone="overlay" frostSource={VOICE_FROST} onPress={stopListening} stretch /> : null}
      {control?.kind === "search" ? <ActionButton testID="voiceSearch" title="Search" variant="glass" tone="overlay" frostSource={VOICE_FROST} onPress={() => searchSpoken(control.text)} stretch /> : null}
      {control?.kind === "search" && browseForMeOffered() ? <ActionButton testID="voiceBrowseForMe" title="Browse for Me" icon="sparkleMagnifyingglass" variant="glass" tone="overlay" frostSource={VOICE_FROST} onPress={() => browseSpoken(control.text)} stretch /> : null}
      {control?.kind === "tryAgain" ? <ActionButton testID="voiceTryAgain" title={actionWords.tryAgain} icon="micFill" tone="overlay" onPress={() => void startListening()} stretch /> : null}
    </View>
  );
}

const VOICE_FROST = "voice";

const styles = StyleSheet.create({
  column: { flex: 1, alignItems: "center", gap: space.huge },
  fill: { flex: 1 },
  bold: { fontWeight: "600" },
  centered: { textAlign: "center" },
  logo: {
    width: voiceLayout.logo,
    height: voiceLayout.logo,
    borderRadius: voiceLayout.logo / 2,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: voiceInk.logoShadow,
  },
  message: { alignItems: "center", gap: space.m, alignSelf: "stretch" },
  transcript: { backgroundColor: voiceInk.transcript, borderRadius: voiceLayout.transcriptRadius, paddingHorizontal: space.xl, paddingVertical: space.m, overflow: "hidden", ...smoothCorners },
  wave: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: voiceLayout.barGap, height: voiceLayout.waveHeight, alignSelf: "stretch" },
  bar: { width: voiceLayout.bar, borderRadius: voiceLayout.bar / 2, backgroundColor: voiceInk.bar },
  controls: { alignSelf: "stretch", minHeight: voiceLayout.pill, gap: space.m },
});
