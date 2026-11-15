import { Dot, Panel, Symbol, Button, tabularNums, Text, useHover } from "../ui";
import { useShallow } from "zustand/react/shallow";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Animated, Image, Pressable, View } from "react-native";
import { switchToTab, toggleMute } from "../../state/browser/actions";
import { useTheme } from "../ui/theme";
import { buttonMotion, curve, usePressScaleMotion } from "../ui/motion";
import { font, radius, space, weight } from "../ui/tokens";
import { useTab } from "../../state/browser/hooks";
import { useMuteState } from "../../state/tabs/hooks";
import { muteTitle } from "../../state/tabs/mute";
import { Favicon } from "../favicon/Favicon";
import { useSidebarTokens } from "../sidebar/tokens";
import { GlassFill, useGlass } from "../ui/Glass";
import { useArtwork } from "../../state/media/artwork";
import { noteSidebarPlayerExpand } from "../../state/telemetry/mediaCardCounts";
import {
  dismissPlayer,
  formatTime,
  isPlaying,
  mediaCommand,
  playerTabFor,
  positionOf,
  sidebarPlayerCandidates,
  skipOrTrack,
  transportIcons,
  useHiddenPlayerTabs,
  useMedia,
  usePictureInPicture,
  useSession,
  useTicker,
  type Session,
} from "../../state/media/media";
import { hostOf } from "@ardia/core";
import { Marquee, useMarqueeGroup } from "./Marquee";
import { TimeBar } from "./MiniPlayer";
import { useMediaTokens } from "./tokens";

const ROW_HEIGHT = 40;
const ROW_INSET = space.s;
const TRAILING_INSET = space.xs;
const ART = 28;
const LIVE_DOT = 6;
const BUTTON = 24;
const TITLE_HEIGHT = 16;
const ARTIST_HEIGHT = 14;
const TITLE_DROP = ARTIST_HEIGHT / 2;
const SEEK_ROW = 18;
const CONTROLS_ROW = 32;
const CONTROLS_GAP = space.s;
const CONTROLS_LIFT = space.s;
const EXPANDED_BOTTOM = space.xs;
const EXPANDED_HEIGHT = ROW_HEIGHT + SEEK_ROW + CONTROLS_ROW + EXPANDED_BOTTOM;
const GROWTH = EXPANDED_HEIGHT - ROW_HEIGHT;
const HOVER_SLOP = space.m;
const EXPAND_MS = 220;
const COLLAPSE_MS = 180;
const COLLAPSE_DELAY_MS = 160;
const UNPIN_MS = 150;
const MARQUEE_PASSES_AT_REST = 1;

export const SIDEBAR_PLAYER_HEIGHT = ROW_HEIGHT + 8;

export type PlayerMotion = {
  progress: Animated.Value;
  overhang: Animated.Value;
  listClip: Animated.AnimatedMultiplication<number>;
  listUnclip: Animated.AnimatedMultiplication<number>;
};

export function usePlayerMotion(): PlayerMotion {
  const [motion] = useState(() => {
    const progress = new Animated.Value(0);
    const overhang = new Animated.Value(1);
    const listClip = Animated.multiply(progress.interpolate({ inputRange: [0, 1], outputRange: [0, -GROWTH] }), overhang);
    return { progress, overhang, listClip, listUnclip: Animated.multiply(listClip, -1) };
  });
  return motion;
}

export function useSidebarPlayerTab(windowId: string, profileId: string): string | undefined {
  const sessions = useMedia(useShallow((m) => Object.keys(m.sessions)));
  const hidden = useHiddenPlayerTabs(windowId, profileId, sessions);
  const candidates = useMedia(useShallow((m) => sidebarPlayerCandidates(m, hidden)));
  const shown = useRef<string | undefined>(undefined);
  shown.current = useMedia((m) => playerTabFor(m, candidates, shown.current));
  return shown.current;
}

const isLive = (session: Session) => session.duration === null;

function useExpansion(want: boolean, motion: PlayerMotion) {
  const [expanded, setExpanded] = useState(false);
  const [slot, setSlot] = useState<"row" | "expanded">("row");
  useEffect(() => {
    if (want === expanded) return;
    if (want) return setExpanded(true);
    const timer = setTimeout(() => setExpanded(false), COLLAPSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [want, expanded]);
  useEffect(() => {
    if (expanded) noteSidebarPlayerExpand();
  }, [expanded]);
  useLayoutEffect(() => {
    if (slot === "expanded") {
      if (expanded) return void motion.overhang.setValue(0);
      return setSlot("row");
    }
    motion.overhang.setValue(1);
    const run = Animated.timing(motion.progress, {
      toValue: expanded ? 1 : 0,
      duration: expanded ? EXPAND_MS : COLLAPSE_MS,
      easing: curve.fade,
      useNativeDriver: true,
    });
    run.start(({ finished }) => finished && expanded && setSlot("expanded"));
    return () => run.stop();
  }, [expanded, slot]);
  useLayoutEffect(
    () => () => {
      motion.progress.setValue(0);
      motion.overhang.setValue(1);
    },
    [],
  );
  return { expanded, slot };
}

function usePinnedTrailing(slot: "row" | "expanded", pin: Animated.Value) {
  const { hovered, hoverProps } = useHover();
  const [pinned, setPinned] = useState(false);
  useLayoutEffect(() => {
    if (hovered && slot === "row" && !pinned) {
      pin.setValue(1);
      setPinned(true);
    } else if (!hovered && pinned) {
      setPinned(false);
    }
  }, [hovered, slot, pinned]);
  useEffect(() => {
    if (pinned) return;
    const run = Animated.timing(pin, { toValue: 0, duration: UNPIN_MS, easing: curve.fade, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [pinned]);
  return { pinned, trailingHoverProps: hoverProps };
}

function TimeLeftRoom({ duration }: { duration: number }) {
  return (
    <View style={{ height: BUTTON, minWidth: BUTTON, paddingHorizontal: space.xs, justifyContent: "center" }}>
      <Text size="caption" style={tabularNums}>
        -{formatTime(duration)}
      </Text>
    </View>
  );
}

function PlayButton({ tabId, playing, size }: { tabId: string; playing: boolean; size: "m" | "l" }) {
  return <Button variant="icon" icon={playing ? "pause.fill" : "play.fill"} size={size} tooltip={playing ? "Pause" : "Play"} onPress={() => mediaCommand(tabId, "toggle")} />;
}

function TimeLeft({ tabId, session }: { tabId: string; session: Session }) {
  const media = useMediaTokens();
  useTicker(true);
  const left = formatTime((session.duration ?? 0) - positionOf(session));
  return (
    <Pressable
      accessibilityLabel={`${left} left`}
      accessibilityHint="Pause"
      onPress={() => mediaCommand(tabId, "toggle")}
      style={{ height: BUTTON, minWidth: BUTTON, paddingHorizontal: space.xs, alignItems: "flex-end", justifyContent: "center" }}
    >
      <Text size="caption" color={media.secondary} style={tabularNums}>
        -{left}
      </Text>
    </Pressable>
  );
}

const PlayerControls = memo(function PlayerControls({ tabId, live, reveal, pinned, onSeeking }: { tabId: string; live: boolean; reveal: Reveal; pinned: boolean; onSeeking: (seeking: boolean) => void }) {
  const media = useMediaTokens();
  const session = useSession(tabId);
  const mute = useMuteState(tabId);
  const playing = isPlaying(session);
  const video = useMedia((m) => !!m.sessions[tabId]?.hasVideo || !!m.pipOpen[tabId]);
  const [pip, togglePip] = usePictureInPicture(tabId);
  useTicker(playing && live);
  if (!session) return null;
  const icons = transportIcons(session);
  return (
    <View style={{ paddingHorizontal: ROW_INSET + 2 }}>
      <Animated.View style={{ height: SEEK_ROW, opacity: reveal.seek }}>
        <TimeBar tabId={tabId} session={session} tokens={media} trailing="total" onDragging={onSeeking} />
      </Animated.View>
      <Animated.View style={{ height: CONTROLS_ROW, flexDirection: "row", alignItems: "center", justifyContent: "space-between", opacity: reveal.controls }}>
        <Button variant="icon" icon={mute ? "speaker.slash.fill" : "speaker.wave.2.fill"} size="m" tooltip={muteTitle(mute)} onPress={() => toggleMute(tabId)} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: CONTROLS_GAP }}>
          <Button variant="icon" icon={icons.back} size="m" tooltip={icons.backTip} onPress={() => skipOrTrack(tabId, session, "back")} />
          <PlayButton tabId={tabId} playing={playing} size="l" />
          <Button variant="icon" icon={icons.ahead} size="m" tooltip={icons.aheadTip} onPress={() => skipOrTrack(tabId, session, "ahead")} />
        </View>
        <Animated.View pointerEvents={pinned ? "none" : "box-none"} style={{ opacity: reveal.unpinned }}>
          {video ? (
            <Button variant="icon" icon={pip ? "pip.exit" : "pip.enter"} size="m" tooltip={pip ? "Exit Picture in Picture" : "Picture in Picture"} onPress={togglePip} />
          ) : (
            <View style={{ width: BUTTON }} />
          )}
        </Animated.View>
      </Animated.View>
    </View>
  );
});

type Reveal = ReturnType<typeof useReveal>;

const PlayerRow = memo(function PlayerRow({ tabId, hovered, reveal }: { tabId: string; hovered: boolean; reveal: Reveal }) {
  const theme = useTheme();
  const media = useMediaTokens();
  const session = useSession(tabId);
  const tab = useTab(tabId);
  const mute = useMuteState(tabId);
  const artwork = useArtwork(tabId, session?.artwork);
  const pressMotion = usePressScaleMotion(true, buttonMotion.controlPressScale);
  const artScaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  const title = session?.title || tab?.title || "";
  const artist = session?.artist || (tab ? hostOf(tab.url) : "");
  const marquee = useMarqueeGroup(`${title}|${artist}`, hovered ? -1 : MARQUEE_PASSES_AT_REST);
  if (!session || !tab) return null;
  return (
    <Pressable
      onPress={() => switchToTab(tabId)}
      onPressIn={pressMotion.onPressIn}
      onPressOut={pressMotion.onPressOut}
      style={{ flex: 1, minWidth: 0, alignSelf: "stretch", flexDirection: "row", alignItems: "center", marginRight: TRAILING_INSET }}
    >
      <Animated.View tooltip="Back to Tab" style={artScaleStyle}>
        <View style={{ width: ART, height: ART, borderRadius: radius.control, overflow: "hidden", backgroundColor: media.artPlaceholder, alignItems: "center", justifyContent: "center" }}>
          {artwork ? <Image source={{ uri: artwork }} resizeMode="cover" style={{ width: ART, height: ART }} /> : <Favicon url={tab.url} favicon={tab.favicon} size={16} profileId={tab.profileId} />}
        </View>
      </Animated.View>
      {isLive(session) ? (
        <View accessibilityLabel="Live" style={{ marginLeft: space.m }}>
          <Dot size={LIVE_DOT} color={theme.destructive} />
        </View>
      ) : null}
      {mute ? <Symbol name="speaker.slash.fill" size={9} color={theme.textSecondary} style={{ width: 13, height: 12, marginLeft: space.s }} /> : null}
      <Animated.View style={{ flex: 1, minWidth: 0, marginLeft: space.s, transform: artist ? [{ translateY: reveal.titleDrop }] : undefined }}>
        <Marquee id="title" text={title} group={marquee} height={TITLE_HEIGHT} style={{ ...font.small, fontWeight: weight.semibold, color: theme.textPrimary }} />
        {artist ? (
          <Animated.View style={{ height: ARTIST_HEIGHT, opacity: reveal.artist }}>
            <Marquee id="artist" text={artist} group={marquee} height={ARTIST_HEIGHT} style={{ ...font.caption, color: theme.textSecondary }} />
          </Animated.View>
        ) : null}
      </Animated.View>
    </Pressable>
  );
});

function useReveal(progress: Animated.Value) {
  const [pin] = useState(() => new Animated.Value(0));
  const [reveal] = useState(() => ({
    pin,
    unpinned: pin.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    trailing: Animated.add(progress.interpolate({ inputRange: [0, 0.5], outputRange: [1, 0], extrapolate: "clamp" }), pin).interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: "clamp" }),
    mask: progress.interpolate({ inputRange: [0, 1], outputRange: [GROWTH, 0] }),
    unmask: progress.interpolate({ inputRange: [0, 1], outputRange: [-GROWTH, 0] }),
    titleDrop: progress.interpolate({ inputRange: [0, 1], outputRange: [TITLE_DROP, 0] }),
    artist: progress.interpolate({ inputRange: [0.3, 1], outputRange: [0, 1], extrapolate: "clamp" }),
    seek: progress.interpolate({ inputRange: [0.7, 1], outputRange: [0, 1], extrapolate: "clamp" }),
    controls: progress.interpolate({ inputRange: [0.45, 1], outputRange: [0, 1], extrapolate: "clamp" }),
    controlsLift: progress.interpolate({ inputRange: [0, 1], outputRange: [-GROWTH + CONTROLS_LIFT, 0] }),
    closing: progress.interpolate({ inputRange: [0.5, 1], outputRange: [0, 1], extrapolate: "clamp" }),
  }));
  return reveal;
}

export function SidebarPlayer({ tabId, motion, docked }: { tabId: string; motion: PlayerMotion; docked: boolean }) {
  const tokens = useSidebarTokens();
  const session = useSession(tabId);
  const shown = useTab(tabId) !== undefined;
  const playing = isPlaying(session);
  const { hovered, hoverProps } = useHover();
  const [seeking, setSeeking] = useState(false);
  const want = hovered || seeking;
  const { expanded, slot } = useExpansion(want, motion);
  const reveal = useReveal(motion.progress);
  const settled = expanded && slot === "expanded";
  const { pinned, trailingHoverProps } = usePinnedTrailing(slot, reveal.pin);
  const glass = useGlass();
  if (!session || !shown) return null;
  const below = docked ? 0 : HOVER_SLOP;

  return (
    <View style={{ height: slot === "expanded" ? EXPANDED_HEIGHT : ROW_HEIGHT }}>
      <View
        {...hoverProps}
        pointerEvents="box-none"
        style={{ position: "absolute", left: -HOVER_SLOP, right: -HOVER_SLOP, bottom: -below, height: (expanded ? EXPANDED_HEIGHT : ROW_HEIGHT) + HOVER_SLOP + below }}
      >
        <View pointerEvents="box-none" style={{ position: "absolute", left: HOVER_SLOP, right: HOVER_SLOP, bottom: below, height: EXPANDED_HEIGHT }}>
          <Animated.View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: EXPANDED_HEIGHT, borderRadius: radius.panel, overflow: "hidden", transform: [{ translateY: reveal.mask }] }}>
            <Animated.View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: EXPANDED_HEIGHT, transform: [{ translateY: reveal.unmask }] }}>
              {glass ? (
                <View style={{ flex: 1, overflow: "hidden", borderRadius: radius.panel }}>
                  <GlassFill radius={radius.panel} state={want ? "lit" : "rest"} />
                </View>
              ) : (
                <Panel fill={tokens.groupFill} radius={radius.panel} border={tokens.groupStroke} style={{ flex: 1 }} />
              )}
            </Animated.View>
            <Animated.View
              pointerEvents={settled ? "box-none" : "none"}
              style={{ position: "absolute", top: ROW_HEIGHT, left: 0, right: 0, transform: [{ translateY: reveal.controlsLift }] }}
            >
              <PlayerControls tabId={tabId} live={expanded} reveal={reveal} pinned={pinned} onSeeking={setSeeking} />
            </Animated.View>
            <View style={{ height: ROW_HEIGHT, flexDirection: "row", alignItems: "center", paddingLeft: ROW_INSET, paddingRight: TRAILING_INSET }}>
              <PlayerRow tabId={tabId} hovered={want} reveal={reveal} />
              <View style={{ minWidth: BUTTON, height: BUTTON, alignItems: "flex-end", justifyContent: "center" }}>
                <View pointerEvents="none" style={{ opacity: 0 }}>
                  {playing && session.duration ? <TimeLeftRoom duration={session.duration} /> : <View style={{ width: BUTTON }} />}
                </View>
                <Animated.View pointerEvents={settled ? "box-none" : "none"} style={{ position: "absolute", top: 0, right: 0, opacity: reveal.closing }}>
                  <Button variant="icon" icon="xmark" size="m" tooltip="Close Player" onPress={() => dismissPlayer(tabId)} />
                </Animated.View>
              </View>
            </View>
          </Animated.View>
          <View
            {...trailingHoverProps}
            pointerEvents="box-none"
            style={{ position: "absolute", right: 0, bottom: 0, height: ROW_HEIGHT, paddingRight: TRAILING_INSET, alignItems: "flex-end", justifyContent: "center" }}
          >
            <Animated.View pointerEvents={pinned || !settled ? "box-none" : "none"} style={{ opacity: reveal.trailing }}>
              {playing && session.duration ? <TimeLeft tabId={tabId} session={session} /> : <PlayButton tabId={tabId} playing={playing} size="m" />}
            </Animated.View>
          </View>
        </View>
      </View>
    </View>
  );
}
