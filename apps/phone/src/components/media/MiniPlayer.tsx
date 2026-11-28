import { useEffect, useRef, useState } from "react";
import { Image, Platform, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { cancelAnimation, Easing, ReduceMotion, runOnJS, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { floatingBarCenter } from "../../lib/deckGeometry";
import { display } from "../../state/search/omnibox";
import { haptics } from "../../state/app/haptics";
import { MINI_PLAYER_WORDS } from "../../state/media/copy";
import { controlsThatFit, MINI_PLAYER_TARGET, miniPlayerLines, skipControls, type PlayingMedia, type SkipControl } from "../../state/media/nowPlaying";
import { closeMiniPlayer, floatMedia, noteMiniPlayerShown, openMiniPlayerTab, setMiniPlayerRoom, skipMedia, toggleMediaPlayback, useMiniPlayer } from "../../state/media/store";
import { useTabs } from "../../state/tabs/store";
import { chromeInk, chromeLayout, ChromeSurface, Favicon, floatingBarLayout, font, PressInPlace, useReduceMotion, useTheme } from "../ui";
import { NativeGlyph } from "../ui/Symbol";
import { GlassSource, PAGE_FROST, START_FROST, SURFACES_FROST } from "../ui/LookViews";
import { useBrowse } from "../../state/browse/store";
import { labTrace } from "../../platform/lab";
import { useBottomBarLayout } from "../ui/useBottomBarLayout";

export const MINI_PLAYER = { height: 56, radius: 28, art: 40, artRadius: 10, button: MINI_PLAYER_TARGET, gap: 10, maxWidth: 480, inMs: 180, outMs: 150, travel: 8, textScale: 1.35 } as const;

export const miniPlayerBottom = (safeBottom: number) => floatingBarCenter(safeBottom, Platform.OS) + floatingBarLayout.control / 2 + MINI_PLAYER.gap;

const entering = Easing.bezier(0, 0, 0.58, 1);
const leaving = Easing.bezier(0.42, 0, 1, 1);

export function MiniPlayer() {
  const { media, shows, skipSeconds } = useMiniPlayer();
  const [present, setPresent] = useState(shows);
  const kept = useRef<PlayingMedia | null>(media);
  const incognito = useTabs((s) => s.incognito);
  if (media) kept.current = media;
  else if (kept.current && kept.current.isPrivate !== incognito) kept.current = null;
  const otherSide = !media && kept.current === null;
  const reduceMotion = useReduceMotion();
  const shown = useSharedValue(0);
  if ((shows || media !== null) && !present) setPresent(true);
  useEffect(() => {
    if (!otherSide) return;
    cancelAnimation(shown);
    shown.value = 0;
    setPresent(false);
  }, [otherSide]);
  const hasMedia = media !== null;
  useEffect(() => {
    labTrace(`MEDIALAB mini ${shows ? "in" : "out"} from ${shown.value.toFixed(2)} present=${present} media=${hasMedia}`);
    if (shows) {
      shown.value = withTiming(1, { duration: MINI_PLAYER.inMs, easing: entering, reduceMotion: ReduceMotion.Never }, (finished) => {
        runOnJS(labTrace)(`MEDIALAB mini in finished=${finished}`);
      });
      return;
    }
    shown.value = withTiming(0, { duration: MINI_PLAYER.outMs, easing: leaving, reduceMotion: ReduceMotion.Never }, (finished) => {
      runOnJS(labTrace)(`MEDIALAB mini out finished=${finished}`);
      if (finished && !hasMedia) runOnJS(setPresent)(false);
    });
  }, [shows, hasMedia]);
  useEffect(() => labTrace(`MEDIALAB mini present=${present}`), [present]);
  useEffect(() => {
    setMiniPlayerRoom(shows ? MINI_PLAYER.height + MINI_PLAYER.gap : 0);
    if (shows && media) noteMiniPlayerShown(media);
  }, [shows, media?.pageId, media?.startedAt]);
  useEffect(() => () => setMiniPlayerRoom(0), []);
  const motion = useAnimatedStyle(() => ({ transform: [{ translateY: reduceMotion ? 0 : (1 - shown.value) * MINI_PLAYER.travel }] }), [reduceMotion]);
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const { span } = useBottomBarLayout(width, chromeLayout.barSideInset);
  const plateWidth = Math.min(width - span.left - span.right, MINI_PLAYER.maxWidth);
  const surface = useBrowse((s) => s.surface);
  const showing = kept.current;
  if (!present || !showing) return null;
  return (
    <View testID="miniPlayerPlace" pointerEvents="box-none" style={[styles.place, { left: span.left, right: span.right, bottom: miniPlayerBottom(insets.bottom) }]}>
      <Animated.View testID="miniPlayer" collapsable={false} pointerEvents={shows ? "box-none" : "none"} accessibilityElementsHidden={!shows} importantForAccessibility={shows ? "auto" : "no-hide-descendants"} style={[styles.motion, motion]}>
        <GlassSource name={surface === "browsing" ? PAGE_FROST : surface === "start" ? START_FROST : SURFACES_FROST}>
          <MiniPlayerCard media={showing} skipSeconds={skipSeconds} plateWidth={plateWidth} fontScale={fontScale} shows={shows} shown={shown} />
        </GlassSource>
      </Animated.View>
    </View>
  );
}

function skipWords(control: SkipControl) {
  const seconds = control.kind === "seconds" ? Math.abs(control.seconds) : 0;
  const backwards = control.kind === "seconds" ? control.seconds < 0 : control.command === "previous";
  const label = control.kind === "track" ? (backwards ? MINI_PLAYER_WORDS.previous : MINI_PLAYER_WORDS.next) : backwards ? MINI_PLAYER_WORDS.back(seconds) : MINI_PLAYER_WORDS.forward(seconds);
  const glyph = control.kind === "track" ? (backwards ? "backward.fill" : "forward.fill") : `${backwards ? "gobackward" : "goforward"}.${seconds}`;
  return { label, glyph, backwards };
}

function MiniPlayerCard({ media, skipSeconds, plateWidth, fontScale, shows, shown }: { media: PlayingMedia; skipSeconds: number; plateWidth: number; fontScale: number; shows: boolean; shown: SharedValue<number> }) {
  const fade = useAnimatedStyle(() => ({ opacity: shown.value }));
  const theme = useTheme();
  const dark = theme.dark || media.isPrivate;
  const ink = dark ? chromeInk.dark : chromeInk.light;
  const tab = useTabs((s) => s.open.find((one) => one.id === media.pageId) ?? s.privates.find((one) => one.id === media.pageId) ?? null);
  const host = tab ? display(tab.url).host : "";
  const lines = miniPlayerLines(media, tab?.title ?? "", host);
  const { back, forward } = skipControls(media, skipSeconds);
  const floats = media.hasVideo && media.canPictureInPicture;
  const fit = controlsThatFit(plateWidth, fontScale, { back: back !== null, forward: forward !== null, pictureInPicture: floats });
  const hidden = [back && !fit.back ? back : null, forward && !fit.forward ? forward : null].filter((control): control is SkipControl => control !== null);
  const spokenExtras = [
    ...hidden.map((control) => ({ name: skipWords(control).backwards ? "skipBack" : "skipForward", label: skipWords(control).label, run: () => skipMedia(media, control) })),
    ...(floats && !fit.pictureInPicture ? [{ name: "pictureInPicture", label: media.inPictureInPicture ? MINI_PLAYER_WORDS.leavePictureInPicture : MINI_PLAYER_WORDS.pictureInPicture, run: () => floatMedia(media) }] : []),
  ];
  const playing = media.state === "playing";
  return (
    <ChromeSurface testID="miniPlayerPlate" shape="capsule" cornerRadius={MINI_PLAYER.radius} incognito={media.isPrivate} dark={dark} barShadow={chromeLayout.barCastsShadow} shown={shows} shownMs={shows ? MINI_PLAYER.inMs : MINI_PLAYER.outMs} fadesWithReduceMotion style={styles.plate}>
      <Animated.View testID="miniPlayerContent" style={[styles.content, fade]}>
        <PressInPlace grow label={MINI_PLAYER_WORDS.open(lines.title)} hint={MINI_PLAYER_WORDS.openHint} actions={spokenExtras.length ? spokenExtras : undefined} onPress={() => openMiniPlayerTab(media)} onPressIn={haptics.barPress} style={styles.lead}>
          <Artwork media={media} faviconUrl={tab?.faviconUrl ?? null} pageUrl={tab?.url ?? null} fill={ink.edge} />
          <View style={styles.lines}>
            <Text testID="miniPlayerTitle" numberOfLines={1} maxFontSizeMultiplier={MINI_PLAYER.textScale} style={[font.subheadline, styles.title, { color: ink.foreground }]}>
              {lines.title}
            </Text>
            <Text testID="miniPlayerDetail" numberOfLines={1} maxFontSizeMultiplier={MINI_PLAYER.textScale} style={[font.footnote, { color: ink.secondary }]}>
              {lines.detail}
            </Text>
          </View>
        </PressInPlace>
        {back && fit.back ? <SkipButton media={media} control={back} color={ink.foreground} /> : null}
        <ControlButton testID="miniPlayerPlayPause" label={playing ? MINI_PLAYER_WORDS.pause : MINI_PLAYER_WORDS.play} glyph={playing ? "pause.fill" : "play.fill"} size={21} color={ink.foreground} onPress={() => toggleMediaPlayback(media)} />
        {forward && fit.forward ? <SkipButton media={media} control={forward} color={ink.foreground} /> : null}
        {floats && fit.pictureInPicture ? (
          <ControlButton testID="miniPlayerPictureInPicture" label={media.inPictureInPicture ? MINI_PLAYER_WORDS.leavePictureInPicture : MINI_PLAYER_WORDS.pictureInPicture} glyph={media.inPictureInPicture ? "pip.exit" : "pip.enter"} size={19} color={ink.foreground} onPress={() => floatMedia(media)} />
        ) : null}
        <ControlButton testID="miniPlayerClose" label={MINI_PLAYER_WORDS.close} glyph="xmark" size={13} weight="semibold" color={ink.secondary} onPress={() => closeMiniPlayer(media)} />
      </Animated.View>
    </ChromeSurface>
  );
}

function Artwork({ media, faviconUrl, pageUrl, fill }: { media: PlayingMedia; faviconUrl: string | null; pageUrl: string | null; fill: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const art = !media.isPrivate && media.artworkUrl && failed !== media.artworkUrl ? media.artworkUrl : null;
  return (
    <View testID="miniPlayerArt" style={[styles.art, { backgroundColor: fill }]}>
      {art ? <Image testID="miniPlayerArtwork" source={{ uri: art }} style={styles.artImage} onError={() => setFailed(art)} accessibilityIgnoresInvertColors /> : <Favicon iconUrl={faviconUrl} pageUrl={pageUrl} size={22} />}
    </View>
  );
}

function SkipButton({ media, control, color }: { media: PlayingMedia; control: SkipControl; color: string }) {
  const { label, glyph, backwards } = skipWords(control);
  return <ControlButton testID={backwards ? "miniPlayerBack" : "miniPlayerForward"} label={label} glyph={glyph} size={control.kind === "track" ? 17 : 19} color={color} onPress={() => skipMedia(media, control)} />;
}

function ControlButton({ testID, label, glyph, size, color, weight = "medium", onPress }: { testID: string; label: string; glyph: string; size: number; color: string; weight?: "medium" | "semibold"; onPress: () => void }) {
  return (
    <PressInPlace label={label} onPress={onPress} onPressIn={haptics.barPress} style={styles.button}>
      <View testID={testID} style={styles.glyph}>
        <NativeGlyph systemName={glyph} pointSize={size} weight={weight} color={color} style={styles.glyph} />
      </View>
    </PressInPlace>
  );
}

const styles = StyleSheet.create({
  place: { position: "absolute", height: MINI_PLAYER.height, alignItems: "center" },
  motion: { width: "100%", maxWidth: MINI_PLAYER.maxWidth, height: MINI_PLAYER.height },
  plate: { flex: 1, flexDirection: "row", alignItems: "center", paddingLeft: 8, paddingRight: 6 },
  content: { flex: 1, flexDirection: "row", alignItems: "center" },
  lead: { flex: 1, minWidth: 0, height: MINI_PLAYER.height, flexDirection: "row", alignItems: "center" },
  art: { width: MINI_PLAYER.art, height: MINI_PLAYER.art, borderRadius: MINI_PLAYER.artRadius, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  artImage: { width: MINI_PLAYER.art, height: MINI_PLAYER.art },
  lines: { flex: 1, minWidth: 0, marginLeft: 10, marginRight: 4, justifyContent: "center" },
  title: { fontWeight: "600" },
  button: { width: MINI_PLAYER.button, height: MINI_PLAYER.height, alignItems: "center", justifyContent: "center" },
  glyph: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },
});
