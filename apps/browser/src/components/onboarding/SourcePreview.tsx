import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { Animated, Image, StyleSheet, View, type ImageSourcePropType, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { Checkbox, Symbol, Text } from "../ui";
import { nativeLoop } from "../ui/motion";
import { radius, space } from "../ui/tokens";
import { useImportFlow } from "../../state/import/flow";
import { importedFrom, importFailed, importSucceeded } from "../../state/onboarding/sourceImport";
import { PRESET_NAMES, presetFor, type BrowserSourceId } from "../../state/onboarding/onboarding";
import { SecondaryButton } from "./Buttons";
import { Tag, useOnboardingColors } from "./Parts";
import { ChoiceCard } from "./ChoiceCard";
import { browserIcon } from "./browserIcons";
import { onboardingButton, onboardingMotion } from "./tokens";
import { createFeed, useGlide, useSwap, type Feed } from "./previewMotion";
import type { SourceTile } from "./sourceTiles";

const ICON = require("../../../assets/app-icon.png");

const FLOW = { icon: 88, path: 196, glyph: 28, glyphSymbol: 12, dots: 9, dot: 3, textWidth: 300, arrow: 22 } as const;
const ROW_WIDTH = FLOW.icon * 2 + FLOW.path + space.l * 2;
const CENTER_X = (ROW_WIDTH - FLOW.icon) / 2;
const CAPTION_TOP = FLOW.icon + space.huge;
type Shape = "tag" | "idle" | "busy";
const CAPTION_GUESS: Record<Shape, number> = { tag: 20, idle: 83, busy: 43 };
const LIST_GUESS = 130;
const GLYPHS = ["bookmark", "clock", "key", "square.on.square"] as const;
const FADE_AT = 0.18;

const styles = StyleSheet.create({
  layer: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center" },
  corner: { position: "absolute", top: 0, left: 0 },
  path: { position: "absolute", left: FLOW.icon + space.l, top: (FLOW.icon - FLOW.glyph) / 2 },
  glyph: { position: "absolute", left: 0, top: 0 },
  centered: { alignItems: "center" },
  hidden: { opacity: 0 },
});

type Motion = Animated.Value | Animated.AnimatedInterpolation<number> | Animated.AnimatedMultiplication<number>;
type ShellStyle = ComponentProps<typeof Animated.View>["style"];

function FeedView({ feed }: { feed: Feed<ReactNode> }) {
  return <>{useSyncExternalStore(feed.subscribe, feed.get, feed.get)}</>;
}

const Shell = memo(function Shell({ style, feed }: { style: ShellStyle; feed: Feed<ReactNode> }) {
  return (
    <Animated.View pointerEvents="box-none" style={style}>
      <FeedView feed={feed} />
    </Animated.View>
  );
});

function Moving({ base, opacity, x, y, children }: { base: ViewStyle; opacity?: Motion; x?: Motion; y?: Motion; children: ReactNode }) {
  const [feed] = useState(() => createFeed<ReactNode>(children));
  useLayoutEffect(() => feed.put(children));
  const style = useMemo(() => [base, { opacity: opacity ?? 1, transform: [{ translateX: x ?? 0 }, { translateY: y ?? 0 }] }], [base, opacity, x, y]);
  return <Shell style={style} feed={feed} />;
}

function wrapped(phase: number, points: readonly [number, number][]) {
  const at = (p: number) => {
    for (let i = 1; i < points.length; i++) {
      const [p0, v0] = points[i - 1]!;
      const [p1, v1] = points[i]!;
      if (p <= p1) return p1 === p0 ? v1 : v0 + ((v1 - v0) * (p - p0)) / (p1 - p0);
    }
    return points[points.length - 1]![1];
  };
  const samples = [...points.map(([p]) => p), phase].filter((p, i, all) => all.indexOf(p) === i).sort((a, b) => a - b);
  const entries: [number, number][] = [];
  for (const p of samples) {
    if (p >= phase) entries.push([p - phase, at(p)]);
    if (p <= phase) entries.push([p - phase + 1, at(p)]);
  }
  const cut = 1 - phase;
  const before = entries.filter(([t]) => t < cut).sort((a, b) => a[0] - b[0]);
  const after = entries.filter(([t]) => t > cut).sort((a, b) => a[0] - b[0]);
  const ordered = [...before, [cut, at(1)] as [number, number], [cut, at(0)] as [number, number], ...after];
  return { inputRange: ordered.map(([t]) => t), outputRange: ordered.map(([, v]) => v) };
}

type GlyphMotion = { name: (typeof GLYPHS)[number]; x: Motion; lift: Motion; opacity: Motion };

const Glyph = memo(function Glyph({ glyph }: { glyph: GlyphMotion }) {
  const colors = useOnboardingColors();
  return (
    <Moving base={styles.glyph} opacity={glyph.opacity} x={glyph.x} y={glyph.lift}>
      <ChoiceCard radius={FLOW.glyph / 2} style={{ width: FLOW.glyph, height: FLOW.glyph, alignItems: "center", justifyContent: "center" }}>
        <Symbol name={glyph.name} size={FLOW.glyphSymbol} weight="medium" color={colors.flowGlyph} style={{ width: FLOW.glyph / 2, height: FLOW.glyph / 2 }} />
      </ChoiceCard>
    </Moving>
  );
});

function GlyphFlow({ flowing }: { flowing: boolean }) {
  const colors = useOnboardingColors();
  const t = useRef(new Animated.Value(0)).current;
  const [looping, setLooping] = useState(flowing);
  if (flowing && !looping) setLooping(true);
  const fade = useGlide(flowing ? 1 : 0, (to) => to === 0 && setLooping(false));
  useEffect(() => {
    if (!looping) return;
    const loop = nativeLoop(t, [{ to: 1, ms: onboardingMotion.importFlow }]);
    loop.start();
    return () => loop.stop();
  }, [looping]);
  const glyphs = useMemo(
    () =>
      GLYPHS.map((name, i): GlyphMotion => {
        const phase = i / GLYPHS.length;
        const travel = FLOW.path - FLOW.glyph;
        return {
          name,
          x: t.interpolate(wrapped(phase, [[0, 0], [1, travel]])),
          lift: t.interpolate(wrapped(phase, [[0, 0], [0.5, -space.s], [1, 0]])),
          opacity: Animated.multiply(t.interpolate(wrapped(phase, [[0, 0], [FADE_AT, 1], [1 - FADE_AT, 1], [1, 0]])), fade),
        };
      }),
    [t, fade],
  );
  return (
    <View style={{ width: FLOW.path, height: FLOW.glyph, justifyContent: "center" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: space.xs }}>
        {Array.from({ length: FLOW.dots }, (_, i) => (
          <View key={i} style={{ width: FLOW.dot, height: FLOW.dot, borderRadius: FLOW.dot / 2, backgroundColor: colors.progressTrack }} />
        ))}
      </View>
      {looping ? glyphs.map((g) => <Glyph key={g.name} glyph={g} />) : null}
    </View>
  );
}

function BrowserMark({ icon, size }: { icon: ImageSourcePropType | null; size: number }) {
  const colors = useOnboardingColors();
  if (icon) return <Image source={icon} style={{ width: size, height: size }} />;
  return (
    <View style={{ width: size, height: size, borderRadius: radius.hero, alignItems: "center", justifyContent: "center", backgroundColor: colors.iconContainer }}>
      <Symbol name="globe" size={size / 3} color={colors.subtitle} style={{ width: size / 2, height: size / 2 }} />
    </View>
  );
}

type Caption = { shape: "tag"; label: string } | { shape: "idle" | "busy"; tile: SourceTile; done: boolean; name: string };
type Mark = { id: BrowserSourceId; icon: ImageSourcePropType | null };

const captionKey = (c: Caption) => (c.shape === "tag" ? `tag:${c.label}` : "import");
const markKey = (m: Mark) => m.id;
const textKey = (s: string) => s;
const tileKey = (t: SourceTile) => t.id;

function Crossfade<T>({ item, keyOf, height, children }: { item: T | null; keyOf: (item: T) => string; height?: number; children: (item: T) => ReactNode }) {
  const layers = useSwap(item, keyOf);
  return (
    <View style={{ alignSelf: "stretch", alignItems: "center" }}>
      {height === undefined ? (
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.hidden}>
          {item === null ? null : children(item)}
        </View>
      ) : (
        <View style={{ height: item === null ? 0 : height }} />
      )}
      {layers.map((l) => (
        <Moving key={l.slot} base={styles.layer} opacity={l.opacity}>
          <View pointerEvents={l.live ? "box-none" : "none"} style={styles.centered}>
            {children(l.item)}
          </View>
        </Moving>
      ))}
    </View>
  );
}

function ImportCaption({ caption, onImport }: { caption: Extract<Caption, { tile: SourceTile }>; onImport: () => void }) {
  const colors = useOnboardingColors();
  const { tile, done, name } = caption;
  const busy = caption.shape === "busy";
  const title = done ? `Imported from ${name}` : busy ? `Importing from ${tile.name}…` : `Bring your stuff from ${tile.name}`;
  return (
    <View style={{ alignItems: "center", gap: space.l, width: FLOW.textWidth }}>
      <View style={{ alignSelf: "stretch", alignItems: "center", gap: space.xs }}>
        <Crossfade item={{ title, done }} keyOf={(t) => t.title}>
          {(t) => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.s }}>
              <Text weight="medium" color={colors.title}>
                {t.title}
              </Text>
              {t.done ? <Checkbox look="ring" size="s" value /> : null}
            </View>
          )}
        </Crossfade>
        <Crossfade item={busy ? "It runs in its own window. Carry on here." : "Bookmarks, history, passwords and tabs."} keyOf={textKey}>
          {(text) => (
            <Text size="small" color={colors.rowSubtitle} style={{ textAlign: "center" }}>
              {text}
            </Text>
          )}
        </Crossfade>
      </View>
      <Crossfade item={busy ? null : tile} keyOf={tileKey} height={onboardingButton.height}>
        {(t) => <SecondaryButton title={`Import from ${t.name}`} filled onPress={onImport} />}
      </Crossfade>
    </View>
  );
}

export function SourcePreview({
  tile,
  fresh,
  found,
  canImport,
  importing,
  onImport,
}: {
  tile: SourceTile | null;
  fresh: boolean;
  found: SourceTile[];
  canImport: boolean;
  importing: BrowserSourceId | null;
  onImport: () => void;
}) {
  const succeeded = useImportFlow(importSucceeded);
  const failed = useImportFlow(importFailed);
  const from = useImportFlow(importedFrom);
  const preset = presetFor(tile?.id ?? (fresh ? "fresh" : null));
  const [listHeight, setListHeight] = useState(LIST_GUESS);
  const [captionHeight, setCaptionHeight] = useState(CAPTION_GUESS);
  const running = !!tile && canImport && importing === tile.id && !failed;
  const done = running && succeeded;
  const listed = found.slice(0, 6);
  const listShown = !tile && !fresh && listed.length > 0;
  const tag = `Starts out ${PRESET_NAMES[preset]}-style`;
  const caption: Caption | null = tile ? (canImport ? { shape: running ? "busy" : "idle", tile, done, name: done ? (from ?? tile.name) : tile.name } : { shape: "tag", label: tag }) : fresh ? { shape: "tag", label: tag } : null;
  const mark: Mark | null = tile ? { id: tile.id, icon: browserIcon(tile.id, tile.icon) } : null;

  const listBlock = listHeight + space.huge;
  const chosenHeight = (shape: Shape) => CAPTION_TOP + captionHeight[shape];
  const stage = Math.max(listed.length ? listBlock + FLOW.icon : 0, chosenHeight("idle"), chosenHeight("busy"), chosenHeight("tag"));
  const pickHeight = (listShown ? listBlock : 0) + FLOW.icon + (caption ? space.huge + captionHeight.tag : 0);
  const top = (stage - (caption && tile ? chosenHeight(caption.shape) : pickHeight)) / 2;
  const ardiaY = tile ? top : top + (listShown ? listBlock : 0);
  const restCaptionTop = (stage - chosenHeight("idle")) / 2 + CAPTION_TOP;

  const rowY = useGlide(ardiaY);
  const ardiaX = useGlide(tile ? ROW_WIDTH - FLOW.icon : CENTER_X);
  const listY = useGlide(top);
  const listOpacity = useGlide(listShown ? 1 : 0);
  const pathOpacity = useGlide(tile ? 1 : 0);
  const captionShift = useGlide(ardiaY + CAPTION_TOP - restCaptionTop);
  const marks = useSwap(mark, markKey);
  const captions = useSwap(caption, captionKey);

  const measureList = (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h !== listHeight) setListHeight(h);
  };
  const measureCaption = (shape: Shape) => (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setCaptionHeight((prev) => (prev[shape] === h ? prev : { ...prev, [shape]: h }));
  };

  return (
    <View style={{ width: ROW_WIDTH, height: stage }}>
      <Moving base={styles.layer} opacity={listOpacity} y={listY}>
        <View pointerEvents="none">
          <PickList found={listed} onLayout={measureList} />
        </View>
      </Moving>
      {marks.map((m) => (
        <Moving key={m.slot} base={styles.corner} opacity={m.opacity} y={rowY}>
          <View pointerEvents="none">
            <BrowserMark icon={m.item.icon} size={FLOW.icon} />
          </View>
        </Moving>
      ))}
      <Moving base={styles.path} opacity={pathOpacity} y={rowY}>
        <View pointerEvents="none">
          <GlyphFlow flowing={!!tile && canImport && !done} />
        </View>
      </Moving>
      <Moving base={styles.corner} x={ardiaX} y={rowY}>
        <Image source={ICON} style={{ width: FLOW.icon, height: FLOW.icon }} />
      </Moving>
      {captions.map((c) => (
        <Moving key={c.slot} base={styles.layer} opacity={c.opacity} y={captionShift}>
          <View pointerEvents={c.live ? "box-none" : "none"} style={{ marginTop: restCaptionTop }} onLayout={c.live ? measureCaption(c.item.shape) : undefined}>
            {c.item.shape === "tag" ? <Tag title={c.item.label} /> : <ImportCaption caption={c.item} onImport={onImport} />}
          </View>
        </Moving>
      ))}
    </View>
  );
}

function PickList({ found, onLayout }: { found: SourceTile[]; onLayout: (e: LayoutChangeEvent) => void }) {
  const colors = useOnboardingColors();
  return (
    <View onLayout={onLayout} style={{ alignItems: "center", gap: space.huge }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.xl, maxWidth: FLOW.textWidth }}>
        {found.map((t) => (
          <View key={t.id} style={{ alignItems: "center", gap: space.s }}>
            <BrowserMark icon={browserIcon(t.id, t.icon)} size={FLOW.icon * 0.64} />
            <Text size="caption" color={colors.subtitle}>
              {t.name}
            </Text>
          </View>
        ))}
      </View>
      <Symbol name="arrow.down" size={16} weight="medium" color={colors.steps} style={{ width: FLOW.arrow, height: FLOW.arrow }} />
    </View>
  );
}
