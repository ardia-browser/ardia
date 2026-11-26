import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, View, type LayoutChangeEvent } from "react-native";
import { useTheme } from "../../ui/theme";
import type { ProfileTheme } from "../../../state/browser/types";
import { DEFAULT_SETTINGS, type Settings } from "../../../state/settings/settings";
import type { PreviewId } from "../../../state/onboarding/previewIds";
import { DEMOS } from "./demos";
import { fill, geo, type Geo } from "./geometry";
import { pageFrameInset } from "../../../lib/windowLayout";
import { windowCornerRadius } from "../../../state/windows/layout";
import { WindowFrame } from "./Kit";
import { lookFor, type Look } from "./look";
import { useBasePaletteValue } from "../../../state/config/hooks";
import type { SceneOpts } from "./scene";
import { useLoop } from "./timeline";
import { mockInk, mockMotion } from "./tokens";
import { useFadeBetween, useTo, WindowState } from "./WindowState";

const INSET = { x: 8, top: 5, bottom: 13 };

type Shape = { top: boolean; addressInSidebar: boolean; appearance: Settings["appearance"]; siteColor: boolean; frame: number };

function shapeOf(settings: Partial<Settings>): Shape {
  const top = (settings.tabLayout ?? DEFAULT_SETTINGS.tabLayout) === "top";
  return {
    top,
    addressInSidebar: !top && (settings.addressBar ?? DEFAULT_SETTINGS.addressBar) === "sidebar",
    appearance: settings.appearance ?? DEFAULT_SETTINGS.appearance,
    siteColor: settings.extendWebsiteColor ?? DEFAULT_SETTINGS.extendWebsiteColor,
    frame: pageFrameInset({ pageFrame: settings.pageFrame ?? DEFAULT_SETTINGS.pageFrame, borderlessMode: settings.borderlessMode }),
  };
}

type MockWindowProps = { settings: Partial<Settings>; accent: string; theme?: ProfileTheme | null; focus: PreviewId | null };

export function MockWindow({ settings, accent, theme = null, focus }: MockWindowProps) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0 && (width !== size?.width || height !== size?.height)) setSize({ width, height });
  };
  return (
    <View style={{ flex: 1, alignSelf: "stretch" }} onLayout={onLayout}>
      {size ? <Window width={size.width} height={size.height} settings={settings} accent={accent} theme={theme} focus={focus} /> : null}
    </View>
  );
}

type SceneLayer = { id: PreviewId; live: boolean };

function useSceneLayers(focus: PreviewId | null) {
  const [layers, setLayers] = useState<SceneLayer[]>(() => (focus ? [{ id: focus, live: true }] : []));
  useEffect(() => {
    setLayers((prev) => {
      const kept = prev.filter((l) => l.id !== focus).map((l) => ({ ...l, live: false })).slice(-1);
      return focus ? [...kept, { id: focus, live: true }] : kept;
    });
  }, [focus]);
  const gone = (id: PreviewId) => setLayers((prev) => prev.filter((l) => l.id !== id || l.live));
  return { layers, gone };
}

function Window({ width, height, settings, accent, theme: custom, focus }: MockWindowProps & { width: number; height: number }) {
  const inner = { w: width - INSET.x * 2, h: height - INSET.top - INSET.bottom };
  const g = useMemo(() => geo(inner.w, inner.h), [inner.w, inner.h]);
  const shape = shapeOf(settings);
  const systemDark = useTheme().dark;
  const dark = shape.appearance === "dark" || (shape.appearance === "auto" && systemDark);
  const lay = useTo(shape.top ? 1 : 0, false);
  const addr = useTo(shape.addressInSidebar ? 1 : 0, false);
  const site = useTo(shape.siteColor ? 1 : 0, true, mockMotion.fade);
  const theme = useFadeBetween(dark);
  const { layers, gone } = useSceneLayers(focus);
  const palette = useBasePaletteValue();
  const look = lookFor(dark, accent, palette);
  const opts = useMemo<SceneOpts>(
    () => ({ top: shape.top, addressInSidebar: shape.addressInSidebar, siteColor: shape.siteColor, frame: shape.frame, systemDark, accent, palette, custom: custom ?? null }),
    [shape.top, shape.addressInSidebar, shape.siteColor, shape.frame, systemDark, accent, palette, custom],
  );
  const layer = (isDark: boolean) => <WindowState g={g} look={lookFor(isDark, accent, palette)} accent={accent} custom={custom ?? null} lay={lay} addr={addr} site={site} frame={shape.frame} />;
  return (
    <View style={{ width, height }}>
      <WindowFrame g={g} look={look} edge={dark ? mockInk.windowEdge.dark : mockInk.windowEdge.light} cornerRadius={windowCornerRadius()} style={{ position: "absolute", left: INSET.x, top: INSET.top, width: inner.w, height: inner.h }}>
        {theme.layers.below !== null ? <View style={fill}>{layer(theme.layers.below)}</View> : null}
        <Animated.View style={[fill, { opacity: theme.layers.below !== null ? theme.fade : 1 }]}>{layer(theme.layers.above)}</Animated.View>
        {layers.map((l) => (
          <SceneFade key={l.id} live={l.live} onGone={() => gone(l.id)}>
            <FocusDemo id={l.id} g={g} look={look} opts={opts} />
          </SceneFade>
        ))}
      </WindowFrame>
    </View>
  );
}

function SceneFade({ live, onGone, children }: { live: boolean; onGone: () => void; children: ReactNode }) {
  const shown = useRef(new Animated.Value(0)).current;
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    const run = Animated.timing(shown, { toValue: live ? 1 : 0, ...mockMotion.focus, useNativeDriver: true, isInteraction: false });
    run.start(({ finished }) => finished && !live && gone.current());
    return () => run.stop();
  }, [live]);
  return <Animated.View style={[fill, { opacity: shown }]}>{children}</Animated.View>;
}

const FocusDemo = memo(function FocusDemo({ id, g, look, opts }: { id: PreviewId; g: Geo; look: Look; opts: SceneOpts }) {
  const { Scene, duration } = DEMOS[id];
  const p = useLoop(duration);
  return <Scene g={g} look={look} p={p} opts={opts} />;
});
