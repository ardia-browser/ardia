import { DIA_SPECTRUM, Meadow, meadowTextStyle, PowerUp, Text, type MeadowIntroEvent, type MeadowTone } from "../ui";
import {
  playIntroMusic,
  setIntroMusicMuted,
  stopIntroMusic,
  type IntroMusicCues,
  introMusicMuted,
  saveIntroMusicMuted,
} from "../../state/onboarding/onboarding";
import { isWebDemo } from "../../state/onboarding/demoSteps";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Image, StyleSheet, View } from "react-native";
import { useTheme } from "../ui/theme";
import { CircleButton, SecondaryButton } from "./Buttons";
import { useOnboardingColors } from "./Parts";
import { curve, springs } from "../ui/motion";
import { space } from "../ui/tokens";
import { onboardingMotion, onboardingType } from "./tokens";
import { EXIT, INTRO_CUES, LETTER, TAGLINE, WORDMARK } from "./introCues";
import { INTRO_COPY, INTRO_LOOK, INTRO_MUTE } from "./introCopy";
import { meadowIntroFor } from "./introPage";
import { noteIntroEnded, noteIntroShown, noteIntroSkipped, type IntroScene } from "../../state/telemetry/introCounts";

const ICON = require("../../../assets/app-icon.png");
const CUES = INTRO_CUES;

const ms = (s: number) => Math.round(s * 1000);
const OPENING_TONE: Record<"day" | "night", MeadowTone> = { day: { tone: "light", halo: 0 }, night: { tone: "dark", halo: 0 } };

export function Intro({ onDone }: { onDone: () => void }) {
  const colors = useOnboardingColors();
  const dark = useTheme().dark;
  const icon = useRef(new Animated.Value(0)).current;
  const letters = useRef([...WORDMARK].map(() => new Animated.Value(0))).current;
  const tagline = useRef(new Animated.Value(0)).current;
  const exit = useRef(new Animated.Value(0)).current;
  const done = useRef(false);
  const skipped = useRef(false);
  const [muted, setMuted] = useState(introMusicMuted);
  const [tone, setTone] = useState(() => OPENING_TONE[dark ? "night" : "day"]);
  const [live, setLive] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const startedAt = useRef(Date.now()).current;
  const scene = useRef<{ shown: IntroScene | null; firstFrameMs: number | null }>({ shown: null, firstFrameMs: null });
  const ink = isWebDemo ? null : meadowTextStyle(tone);
  const pageIntro = useMemo(() => meadowIntroFor({ colors, muted, startedAt }), [colors, muted]);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    noteIntroEnded({ skipped: skipped.current, ...scene.current });
    onDone();
  };

  useEffect(() => {
    const ease = curve.enter;
    const lag = Date.now() - startedAt;
    const at = (s: number) => ({ delay: Math.max(0, ms(s) - lag), useNativeDriver: true });
    const sequence = Animated.parallel([
      Animated.spring(icon, { toValue: 1, ...springs.smooth, ...at(CUES.icon) }),
      ...letters.map((l, i) =>
        Animated.timing(l, { toValue: 1, duration: ms(LETTER), easing: ease, ...at(CUES.letters + i * CUES.letterStep) }),
      ),
      Animated.timing(tagline, { toValue: 1, duration: ms(TAGLINE), easing: ease, ...at(CUES.tagline) }),
      Animated.timing(exit, { toValue: 1, duration: ms(EXIT), easing: curve.move, ...at(CUES.exit) }),
    ]);
    noteIntroShown(introMusicMuted());
    playIntroMusic(CUES, introMusicMuted());
    sequence.start(({ finished }) => finished && finish());
    return () => sequence.stop();
  }, []);

  const skip = () => {
    if (skipped.current || done.current) return;
    skipped.current = true;
    setLeaving(true);
    noteIntroSkipped();
    stopIntroMusic(0.35);
    Animated.timing(exit, { toValue: 1, duration: onboardingMotion.introSkip, easing: curve.enter, useNativeDriver: true }).start(finish);
  };

  const muteTo = (next: boolean) => {
    setMuted(next);
    setIntroMusicMuted(next);
    saveIntroMusicMuted(next);
  };

  const onIntro = (event: MeadowIntroEvent) => {
    if (event.kind === "live") {
      setLive(true);
      scene.current = { shown: "animated", firstFrameMs: event.firstFrameMs };
    } else if (event.kind === "fallback") {
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
          opacity: exit.interpolate({ inputRange: [0, INTRO_LOOK.exitHold, 1], outputRange: [1, 1, 0] }),
        },
      ]}
    >
      {isWebDemo ? (
        <PowerUp palette={DIA_SPECTRUM} speed={0.8} origin={0.5} style={[StyleSheet.absoluteFill, { opacity: dark ? 0.9 : 0.6 }]} />
      ) : (
        <Meadow night={dark} onTone={setTone} intro={leaving && !live ? undefined : pageIntro} onIntro={onIntro} style={StyleSheet.absoluteFill} />
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
        <Animated.View
          style={{
            opacity: icon.interpolate({ inputRange: [0, INTRO_LOOK.iconOpaque, 1], outputRange: [0, 1, 1], extrapolate: "clamp" }),
            transform: [{ scale: icon.interpolate({ inputRange: [0, 1], outputRange: [INTRO_LOOK.iconFrom, 1] }) }],
          }}
        >
          <Image source={ICON} style={{ width: INTRO_LOOK.icon, height: INTRO_LOOK.icon }} />
        </Animated.View>
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
        <Animated.View style={{ opacity: tagline, transform: [{ translateY: tagline.interpolate({ inputRange: [0, 1], outputRange: [INTRO_LOOK.taglineRise, 0] }) }] }}>
          <Text color={colors.subtitle} style={[onboardingType.tagline, ink]}>
            {INTRO_COPY.tagline}
          </Text>
        </Animated.View>
      </Animated.View>
      {live ? null : (
        <>
          <View style={{ position: "absolute", left: INTRO_LOOK.inset, bottom: INTRO_LOOK.inset }}>
            <CircleButton
              title={muteLabel}
              tooltip={muteLabel}
              icon={muted ? INTRO_MUTE.mutedIcon : INTRO_MUTE.playingIcon}
              size={INTRO_MUTE.iconSize}
              symbolWeight={INTRO_MUTE.iconWeight}
              box={INTRO_MUTE.iconBox}
              onPress={() => muteTo(!muted)}
            />
          </View>
          <View style={{ position: "absolute", right: INTRO_LOOK.inset, bottom: INTRO_LOOK.inset }} accessibilityHint={INTRO_COPY.skipHint}>
            <SecondaryButton title={INTRO_COPY.skip} onPress={skip} />
          </View>
        </>
      )}
    </Animated.View>
  );
}
