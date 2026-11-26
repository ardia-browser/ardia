import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, View } from "react-native";
import { ThemeBackdrop } from "../../settings/ThemeControls";
import { resolveTheme } from "../../../lib/profileLook";
import type { ProfileTheme } from "../../../state/browser/types";
import { CARD_INSET, pageFrameOf } from "../../../lib/windowLayout";
import { windowCornerRadius } from "../../../state/windows/layout";
import { useBasePaletteValue } from "../../../state/config/hooks";
import { tab } from "./content";
import { CHIP, CHIP_STEP, CRUMB_X, FIELD, FIELD_CRUMB, fill, type Geo, LIGHTS_Y, restChipCount, restRowCount, ROW, SIDEBAR_ICONS, SIDEBAR_W, STRIP_H, TOOLBAR_H, TOOLBAR_ICONS } from "./geometry";
import { Backdrop, Card, Crumb, FieldPlate, Lights, NavIcons, Rows, TabRow, ToolbarBand, TopTabPlate, type Styles } from "./Kit";
import { lookFor, type Look } from "./look";
import { Page } from "./MockPages";
import { mockMotion } from "./tokens";

export function useTo(value: number, native: boolean, config: { duration: number; easing: (value: number) => number } = mockMotion.move) {
  const v = useRef(new Animated.Value(value)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const run = Animated.timing(v, { toValue: value, ...config, useNativeDriver: native, isInteraction: false });
    run.start();
    return () => run.stop();
  }, [value]);
  return v;
}

export function useFadeBetween<T>(value: T) {
  const [layers, setLayers] = useState<{ below: T | null; above: T }>({ below: null, above: value });
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (value === layers.above) return;
    setLayers({ below: layers.above, above: value });
    fade.setValue(0);
    const run = Animated.timing(fade, { toValue: 1, ...mockMotion.fade, useNativeDriver: true, isInteraction: false });
    run.start(({ finished }) => finished && setLayers({ below: null, above: value }));
    return () => run.stop();
  }, [value]);
  return { layers, fade };
}

function AccentBackdrop({ look, accent, custom }: { look: Look; accent: string; custom: ProfileTheme | null }) {
  const { layers, fade } = useFadeBetween(accent);
  const palette = useBasePaletteValue();
  const customShown = useTo(custom ? 1 : 0, true, mockMotion.fade);
  return (
    <View style={fill} pointerEvents="none">
      {layers.below !== null ? <Backdrop look={lookFor(look.dark, layers.below, palette)} /> : null}
      <Animated.View style={[fill, { opacity: layers.below !== null ? fade : 1 }]}>
        <Backdrop look={lookFor(look.dark, layers.above, palette)} />
      </Animated.View>
      {custom ? (
        <Animated.View style={[fill, { opacity: customShown }]}>
          <ThemeBackdrop theme={resolveTheme(custom, look.dark)} dark={look.dark} style={fill} />
        </Animated.View>
      ) : null}
    </View>
  );
}

export type SiteTint = Animated.Value | Animated.AnimatedInterpolation<number> | number;

export function SiteBand({ look, site }: { look: Look; site: SiteTint }) {
  return (
    <Animated.View style={[fill, { opacity: site }]}>
      <View style={[fill, { backgroundColor: look.site.background ?? look.card }]} />
    </Animated.View>
  );
}

export function SelectedChip({ g, look, site, x = CHIP.x, style }: { g: Geo; look: Look; site: SiteTint; x?: number; style?: Styles }) {
  return (
    <TopTabPlate g={g} look={look} x={x} style={style}>
      <SiteBand look={look} site={site} />
    </TopTabPlate>
  );
}

export function RestChips({ g, look, site, from = 0 }: { g: Geo; look: Look; site: SiteTint; from?: number }) {
  return (
    <>
      <SelectedChip g={g} look={look} site={site} />
      {Array.from({ length: restChipCount(g) }, (_, i) => (
        <TabRow key={i} g={g} look={look} t={tab(from + i)} x={CHIP.x + i * CHIP_STEP} y={CHIP.top - 1} w={CHIP.w} />
      ))}
    </>
  );
}

export type WindowSlots = { rows?: ReactNode; chips?: ReactNode; page?: ReactNode; crumb?: ReactNode; card?: ReactNode; over?: ReactNode };

type WindowStateProps = { g: Geo; look: Look; accent: string; custom: ProfileTheme | null; lay: Animated.Value; addr: Animated.Value; site: Animated.Value | Animated.AnimatedInterpolation<number>; frame: number; slots?: WindowSlots };

export const WindowState = memo(function WindowState({ g, look, accent, custom, lay, addr, site, frame, slots = {} }: WindowStateProps) {
  const s = g.s;
  const sideCardX = SIDEBAR_W + Math.max(0, frame - ROW.x);
  const lightsY = LIGHTS_Y.toolbar - CARD_INSET + frame;
  const cardRadius = pageFrameOf(frame, windowCornerRadius()).radius * s;
  const lerp = (v: Animated.Value, a: number, b: number) => v.interpolate({ inputRange: [0, 1], outputRange: [a * s, b * s] });
  const fade = (v: Animated.Value | Animated.AnimatedInterpolation<number>, a: number, b: number) => v.interpolate({ inputRange: [0, 1], outputRange: [a, b] });
  const sideCardW = g.W - sideCardX - frame;
  const crumbLeft = Animated.add(lerp(lay, sideCardX + CRUMB_X, frame + 118), lerp(addr, 0, FIELD.x + FIELD_CRUMB.x - (sideCardX + CRUMB_X)));
  const crumbTop = Animated.add(lerp(lay, frame + 12, STRIP_H + 12), lerp(addr, 0, FIELD.y + FIELD_CRUMB.y - (frame + 12)));
  return (
    <View style={fill}>
      <AccentBackdrop look={look} accent={accent} custom={custom} />
      <Animated.View style={{ position: "absolute", left: 0, top: 0, width: 80 * s, height: 50 * s, transform: [{ translateX: lerp(lay, 0, 20.75 - 25) }, { translateY: Animated.add(lerp(lay, lightsY - LIGHTS_Y.toolbar, LIGHTS_Y.strip - LIGHTS_Y.toolbar), lerp(addr, 0, LIGHTS_Y.field - lightsY)) }] }}>
        <Lights g={g} />
      </Animated.View>
      <Animated.View style={[fill, { opacity: fade(lay, 1, 0), transform: [{ translateX: lerp(lay, 0, -60) }] }]}>
        <NavIcons g={g} color={look.t.icon} xs={SIDEBAR_ICONS} y={LIGHTS_Y.field} names={["sidebar.left", "chevron.left", "chevron.right"]} style={{ opacity: fade(addr, 0, 1) }} />
        <Animated.View style={[fill, { transform: [{ translateY: lerp(addr, 0, ROW.topWithField - ROW.top) }] }]}>
          {slots.rows !== undefined ? slots.rows : <Rows g={g} look={look} n={restRowCount(g)} sel={0} />}
        </Animated.View>
        <FieldPlate
          g={g}
          look={look}
          style={{
            left: Animated.add(crumbLeft, -FIELD_CRUMB.x * s),
            top: Animated.add(crumbTop, -FIELD_CRUMB.y * s),
            width: lerp(addr, 320, FIELD.w),
            height: FIELD.h * s,
            opacity: fade(addr, 0, 1),
          }}
        />
      </Animated.View>
      <Animated.View style={[fill, { opacity: lay, transform: [{ translateY: lerp(lay, -8, 0) }] }]}>{slots.chips !== undefined ? slots.chips : <RestChips g={g} look={look} site={site} />}</Animated.View>
      <Card
        g={g}
        look={look}
        style={{
          left: lerp(lay, sideCardX, frame),
          top: lerp(lay, frame, STRIP_H),
          width: lerp(lay, sideCardW, g.W - 2 * frame),
          height: lerp(lay, g.H - 2 * frame, g.H - STRIP_H - frame),
          borderRadius: cardRadius,
        }}
      >
        <Animated.View style={[fill, { transform: [{ translateY: lerp(addr, 0, -TOOLBAR_H) }] }]}>{slots.page !== undefined ? slots.page : <Page g={g} look={look} top={TOOLBAR_H} />}</Animated.View>
        <ToolbarBand g={g} fill={look.card} divider={look.plain.divider} dividerStyle={{ opacity: fade(site, 1, 0) }} style={{ opacity: fade(addr, 1, 0) }}>
          <SiteBand look={look} site={site} />
          <Animated.View style={[fill, { opacity: fade(lay, 1, 0) }]}>
            <NavIcons g={g} color={look.plain.icon} xs={TOOLBAR_ICONS} y={21.2} />
          </Animated.View>
          <Animated.View style={[fill, { opacity: lay }]}>
            <NavIcons g={g} color={look.plain.icon} xs={[21, 56, 92]} y={21.2} names={["chevron.left", "chevron.right", "arrow.clockwise"]} />
          </Animated.View>
        </ToolbarBand>
        {slots.card}
      </Card>
      <Animated.View style={{ position: "absolute", left: crumbLeft, top: crumbTop, width: lerp(addr, 300, FIELD_CRUMB.w), height: FIELD_CRUMB.h * s, overflow: "hidden" }}>
        {slots.crumb !== undefined ? slots.crumb : <Crumb g={g} look={look} t={tab(0)} />}
      </Animated.View>
      {slots.over}
    </View>
  );
});
