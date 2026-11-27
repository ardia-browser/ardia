import { DIA_SPECTRUM, Meadow, meadowTextStyle, PowerUp, Text, type MeadowIntroEvent, type MeadowTone } from "../ui";
import {
  playIntroMusic,
  setIntroMusicMuted,
  stopIntroMusic,
  introMusicMuted,
  introStartDelayMs,
  saveIntroMusicMuted,
} from "../../state/onboarding/onboarding";
import { isWebDemo } from "../../state/onboarding/demoSteps";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, findNodeHandle, Image, StyleSheet, View } from "react-native";
import { useTheme } from "../ui/theme";
import { CircleButton, SecondaryButton } from "./Buttons";
import { useOnboardingColors } from "./Parts";
import { curve, springs } from "../ui/motion";
import { space } from "../ui/tokens";
import { onboardingMotion, onboardingType } from "./tokens";
import { EXIT, INTRO_CUES, LETTER, TAGLINE, WORDMARK } from "./introCues";
import { INTRO_COPY, INTRO_LOOK, INTRO_MUTE } from "./introCopy";
import { meadowIntroFor } from "./introPage";
import { INTRO_TAB_KEYS, introHoldsKeyboard, nextIntroStop } from "./introKeys";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { noteIntroEnded, noteIntroShown, noteIntroSkipped, type IntroScene } from "../../state/telemetry/introCounts";
import { consentToken } from "../../state/telemetry/client";

const CUES = INTRO_CUES;
const ICON = require("../../../assets/app-icon.png");

const ms = (s: number) => Math.round(s * 1000);
const OPENING_TONE: Record<"day" | "night", MeadowTone> = { day: { tone: "light", halo: 0 }, night: { tone: "dark", halo: 0 } };

const PAGE_GONE_LIMIT_MS = 600;
const MEADOW_READY_LIMIT_MS = 2500;
const CREEPER_BOOM_LIMIT_MS = 9000;

const ESCAPE_KEYS = [{ key: "Escape" }];

export function Intro({ onDone, onExitStart, overlay = false }: { onDone: () => void; onExitStart?: (burst: boolean) => void; overlay?: boolean }) {
  const colors = useOnboardingColors();
  const dark = useTheme().dark;
  const creeper = overlay && dark;
  const icon = useRef(new Animated.Value(0)).current;
  const letters = useRef([...WORDMARK].map(() => new Animated.Value(0))).current;
  const tagline = useRef(new Animated.Value(0)).current;
  const exit = useRef(new Animated.Value(0)).current;
  const appear = useRef(new Animated.Value(overlay ? 0 : 1)).current;
  const boomed = useRef(false);
  const consent = useRef(consentToken()).current;
  const exitStarted = useRef(false);
  const escapeKeys = useRef<View>(null);
  const done = useRef(false);
  const skipped = useRef(false);
  const [muted, setMuted] = useState(introMusicMuted);
  const [tone, setTone] = useState(() => OPENING_TONE[dark ? "night" : "day"]);
  const [live, setLive] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const started = useRef(Date.now() + introStartDelayMs());
  const [began, setBegan] = useState(!overlay);
  const scene = useRef<{ shown: IntroScene | null; firstFrameMs: number | null }>({ shown: null, firstFrameMs: null });
  const pageOpen = useRef<(() => void) | null>(null);
  const pageGone = useRef<Promise<void>>(Promise.resolve());
  const ink = isWebDemo ? null : meadowTextStyle(tone);
  const pageIntro = useMemo(() => meadowIntroFor({ colors, muted, startedAt: started.current }), [colors, muted]);
  const keys = useRef<View>(null);
  const muteStop = useRef<View>(null);
  const skipStop = useRef<View>(null);
  const holdsKeys = introHoldsKeyboard({ live, leaving, tabReachesUnderOverlays: PLATFORM_FEATURES.tabReachesUnderOverlays });

  const catchesEscape = overlay || (!holdsKeys && !live);

  useEffect(() => {
    if (holdsKeys && !overlay) keys.current?.focus();
    else if (catchesEscape) escapeKeys.current?.focus();
  }, [holdsKeys, catchesEscape]);

  const tab = (target: number | undefined, shift: boolean) => {
    const stops = [muteStop, skipStop];
    const focused = stops.findIndex((stop) => target !== undefined && stop.current !== null && findNodeHandle(stop.current) === target);
    stops[nextIntroStop(focused, shift, stops.length)]?.current?.focus();
  };

  const startExit = (burst = false) => {
    if (exitStarted.current) return;
    exitStarted.current = true;
    onExitStart?.(burst);
  };

  const finish = () => {
    if (done.current) return;
    done.current = true;
    noteIntroEnded({ skipped: skipped.current, ...scene.current }, consent);
    void Promise.race([pageGone.current, new Promise((settle) => setTimeout(settle, PAGE_GONE_LIMIT_MS))]).then(onDone);
  };

  const pageClosed = () => {
    pageOpen.current?.();
    pageOpen.current = null;
  };

  useEffect(() => {
    if (began || !overlay) return;
    const fallback = setTimeout(() => setBegan(true), MEADOW_READY_LIMIT_MS);
    return () => clearTimeout(fallback);
  }, [began]);

  useEffect(() => {
    if (!began || exitStarted.current) return;
    if (overlay) started.current = Date.now();
    const ease = curve.enter;
    const lag = Date.now() - started.current;
    const at = (s: number) => ({ delay: Math.max(0, ms(s) - lag), useNativeDriver: true });
    const sequence = Animated.parallel([
      Animated.spring(icon, { toValue: 1, ...springs.smooth, ...at(CUES.icon) }),
      ...letters.map((l, i) =>
        Animated.timing(l, { toValue: 1, duration: ms(LETTER), easing: ease, ...at(CUES.letters + i * CUES.letterStep) }),
      ),
      Animated.timing(tagline, { toValue: 1, duration: ms(TAGLINE), easing: ease, ...at(CUES.tagline) }),
      ...(creeper ? [] : [Animated.timing(exit, { toValue: 1, duration: ms(EXIT), easing: curve.move, ...at(CUES.exit) })]),
    ]);
    noteIntroShown(introMusicMuted());
    playIntroMusic(CUES, introMusicMuted());
    sequence.start(({ finished }) => finished && !creeper && finish());
    if (overlay) Animated.timing(appear, { toValue: 1, duration: ms(INTRO_LOOK.appearIn), easing: ease, useNativeDriver: true }).start();
    const exitTimer = creeper ? setTimeout(boom, CREEPER_BOOM_LIMIT_MS) : setTimeout(() => startExit(), Math.max(0, ms(CUES.exit) - lag));
    return () => {
      sequence.stop();
      clearTimeout(exitTimer);
    };
  }, [began]);

  useEffect(() => {
    if (!overlay) return;
    let wasActive = AppState.currentState === "active";
    const watch = AppState.addEventListener("change", (state) => {
      if (state === "active") wasActive = true;
      else if (wasActive) skip();
    });
    return () => watch.remove();
  }, []);

  const boom = () => {
    if (boomed.current || skipped.current || done.current) return;
    boomed.current = true;
    startExit(true);
    Animated.timing(exit, { toValue: 1, duration: ms(INTRO_LOOK.boomFade), easing: curve.exit, useNativeDriver: true }).start(finish);
  };

  const skip = () => {
    if (skipped.current || done.current) return;
    skipped.current = true;
    setLeaving(true);
    noteIntroSkipped(consent);
    stopIntroMusic(0.35);
    startExit();
    Animated.timing(exit, { toValue: 1, duration: onboardingMotion.introSkip, easing: curve.enter, useNativeDriver: true }).start(finish);
  };

  const muteTo = (next: boolean) => {
    setMuted(next);
    setIntroMusicMuted(next);
    saveIntroMusicMuted(next);
  };

  const onIntro = (event: MeadowIntroEvent) => {
    if (event.kind === "live") {
      pageGone.current = new Promise((closed) => (pageOpen.current = closed));
      setLive(true);
      scene.current = { shown: "animated", firstFrameMs: event.firstFrameMs };
    } else if (event.kind === "closed") pageClosed();
    else if (event.kind === "fallback") {
      pageClosed();
      setLive(false);
      scene.current = { ...scene.current, shown: "fallback" };
    } else if (event.kind === "poster") scene.current = { ...scene.current, shown: "poster" };
    else if (event.kind === "skip") skip();
    else if (event.kind === "mute") muteTo(event.muted);
  };

  const muteLabel = muted ? INTRO_COPY.unmute : INTRO_COPY.mute;
  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: colors.background,
          alignItems: "center",
          justifyContent: "center",
          opacity: overlay ? Animated.multiply(appear, exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] })) : exit.interpolate({ inputRange: [0, INTRO_LOOK.exitHold, 1], outputRange: [1, 1, 0] }),
        },
      ]}
    >
      {isWebDemo ? (
        <PowerUp palette={DIA_SPECTRUM} speed={0.8} origin={0.5} style={[StyleSheet.absoluteFill, { opacity: dark ? 0.9 : 0.6 }]} />
      ) : (
        <Meadow night={dark} creeper={creeper} onBoom={creeper ? boom : undefined} onReady={overlay ? () => setBegan(true) : undefined} onTone={setTone} intro={leaving && !live ? undefined : pageIntro} onIntro={onIntro} style={StyleSheet.absoluteFill} />
      )}
      <Animated.View
        accessibilityElementsHidden={live}
        style={{
          alignItems: "center",
          gap: space.xl,
          opacity: live ? 0 : 1,
          transform: [{ scale: exit.interpolate({ inputRange: [0, 1], outputRange: [1, INTRO_LOOK.exitScale] }) }],
        }}
      >
        {overlay ? null : (
          <Animated.View
            style={{
              opacity: icon.interpolate({ inputRange: [0, INTRO_LOOK.iconOpaque, 1], outputRange: [0, 1, 1], extrapolate: "clamp" }),
              transform: [{ scale: icon.interpolate({ inputRange: [0, 1], outputRange: [INTRO_LOOK.iconFrom, 1] }) }],
            }}
          >
            <Image source={ICON} style={{ width: INTRO_LOOK.icon, height: INTRO_LOOK.icon }} />
          </Animated.View>
        )}
        {overlay ? null : (
          <View style={{ flexDirection: "row" }} accessibilityLabel={WORDMARK}>
            {[...WORDMARK].map((ch, i) => (
              <Animated.Text
                key={i}
                style={{
                  ...onboardingType.wordmark,
                  color: colors.title,
                  ...ink,
                  opacity: letters[i],
                  transform: [{ translateY: letters[i]!.interpolate({ inputRange: [0, 1], outputRange: [INTRO_LOOK.letterRise, 0] }) }],
                }}
              >
                {ch}
              </Animated.Text>
            ))}
          </View>
        )}
        {overlay ? null : (
          <Animated.View style={{ opacity: tagline, transform: [{ translateY: tagline.interpolate({ inputRange: [0, 1], outputRange: [INTRO_LOOK.taglineRise, 0] }) }] }}>
            <Text color={colors.subtitle} style={[onboardingType.tagline, ink]}>
              {INTRO_COPY.tagline}
            </Text>
          </Animated.View>
        )}
      </Animated.View>
      {catchesEscape ? (
        <View
          ref={escapeKeys}
          style={StyleSheet.absoluteFill}
          pointerEvents={overlay ? "auto" : "none"}
          focusable
          enableFocusRing={false}
          keyDownEvents={ESCAPE_KEYS}
          onKeyDown={(e) => {
            if (e.nativeEvent.key === "Escape") skip();
          }}
        />
      ) : null}
      {live || overlay ? null : (
        <View
          ref={keys}
          style={StyleSheet.absoluteFill}
          pointerEvents="box-none"
          focusable={holdsKeys}
          enableFocusRing={false}
          keyDownEvents={holdsKeys ? [...INTRO_TAB_KEYS, ...ESCAPE_KEYS] : undefined}
          onKeyDown={(e) => {
            if (!holdsKeys) return;
            if (e.nativeEvent.key === "Escape") skip();
            else if (e.nativeEvent.key === "Tab") tab((e.nativeEvent as { target?: number }).target, e.nativeEvent.shiftKey);
          }}
        >
          <View style={{ position: "absolute", left: INTRO_LOOK.inset, bottom: INTRO_LOOK.inset }}>
            <CircleButton
              title={muteLabel}
              tooltip={muteLabel}
              icon={muted ? INTRO_MUTE.mutedIcon : INTRO_MUTE.playingIcon}
              size={INTRO_MUTE.iconSize}
              symbolWeight={INTRO_MUTE.iconWeight}
              box={INTRO_MUTE.iconBox}
              onPress={() => muteTo(!muted)}
              pressRef={muteStop}
            />
          </View>
          <View style={{ position: "absolute", right: INTRO_LOOK.inset, bottom: INTRO_LOOK.inset }} accessibilityHint={INTRO_COPY.skipHint}>
            <SecondaryButton title={INTRO_COPY.skip} onPress={skip} pressRef={skipStop} />
          </View>
        </View>
      )}
    </Animated.View>
  );
}
