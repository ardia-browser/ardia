import { useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import Svg, { Circle, Defs, Path, RadialGradient, Stop } from "react-native-svg";
import { colorHex, stopLightness, withStopAt, withStopLightness, type ProfileTheme } from "@ardia/core/src/theme.ts";
import { dialAngle, lightnessSteps, padCentre, padPoint, padWedges, stepped, stopAt, turnedStop } from "../../lib/themeEditor";
import { capsule, font, ink, settingsLayout, space, themeEditorInk, themeEditorLayout as L, useTheme } from "../ui";
import { t } from "../../lib/uiLanguage";


type Change = (next: ProfileTheme, settle: boolean) => void;

export type BlockedScroll = Parameters<ReturnType<typeof Gesture.Pan>["blocksExternalGesture"]>[0];

type Blocks = { blocks?: BlockedScroll };

const WEDGES = padWedges(L.padWedges, L.pad);
const CENTRE = padCentre();

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function ColorPad({ theme, selected, onSelect, onChange, blocks }: { theme: ProfileTheme; selected: number; onSelect: (index: number) => void; onChange: Change } & Blocks) {
  const latest = useRef({ theme, selected, onSelect, onChange });
  latest.current = { theme, selected, onSelect, onChange };
  const dragging = useRef<number | null>(null);
  const pan = useMemo(() => {
    const move = (x: number, y: number, settle: boolean) => {
      const index = dragging.current;
      if (index === null) return;
      const p = padPoint(x, y, L.pad);
      latest.current.onChange(withStopAt(latest.current.theme, index, p.x, p.y), settle);
    };
    const begin = (x: number, y: number) => {
      const hit = stopAt(latest.current.theme, x, y, L.pad, L.knob / 2 + L.knobHitSlop);
      dragging.current = hit >= 0 ? hit : latest.current.selected;
      latest.current.onSelect(dragging.current);
      if (hit < 0) move(x, y, false);
    };
    const finish = (success: boolean) => {
      if (!success && dragging.current !== null) latest.current.onChange(latest.current.theme, true);
      dragging.current = null;
    };
    const gesture = Gesture.Pan()
      .withTestId("themePad")
      .minDistance(0)
      .onBegin((e) => {
        runOnJS(begin)(e.x, e.y);
      })
      .onUpdate((e) => {
        runOnJS(move)(e.x, e.y, false);
      })
      .onEnd((e) => {
        runOnJS(move)(e.x, e.y, true);
      })
      .onFinalize((_e, success) => {
        runOnJS(finish)(success);
      });
    return blocks ? gesture.blocksExternalGesture(blocks) : gesture;
  }, [blocks]);
  const turn = (by: number) => onChange(turnedStop(theme, selected, by), true);
  return (
    <GestureDetector gesture={pan}>
      <View
        testID="themePad"
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Color ${selected + 1}`}
        accessibilityValue={{ text: theme.stops[selected] ? colorHex(theme.stops[selected]!.color) : "" }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => turn(event.nativeEvent.actionName === "increment" ? L.accessibilityTurn : -L.accessibilityTurn)}
        style={styles.pad}
      >
        <Svg width={L.pad} height={L.pad} pointerEvents="none">
          <Defs>
            <RadialGradient id="padGrey" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={CENTRE} stopOpacity={1} />
              <Stop offset="1" stopColor={CENTRE} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          {WEDGES.map((wedge) => (
            <Path key={wedge.path} d={wedge.path} fill={wedge.fill} />
          ))}
          <Circle cx={L.pad / 2} cy={L.pad / 2} r={L.pad / 2} fill="url(#padGrey)" />
        </Svg>
        {theme.stops.map((stop, index) => (
          <View
            key={index}
            pointerEvents="none"
            style={[
              styles.knob,
              { left: stop.x * L.pad - L.knob / 2, top: stop.y * L.pad - L.knob / 2, backgroundColor: colorHex(stop.color), borderWidth: index === selected ? L.knobBorderSelected : L.knobBorder },
            ]}
          >
            <View style={styles.halo} />
          </View>
        ))}
      </View>
    </GestureDetector>
  );
}

function Track({ value, onChange, bar, thumbColor, label, blocks }: { value: number; onChange: (value: number, settle: boolean) => void; bar: ReactNode; thumbColor?: string; label: string } & Blocks) {
  const [width, setWidth] = useState(0);
  const latest = useRef({ value, width, onChange });
  latest.current = { value, width, onChange };
  const gesture = useMemo(() => {
    const report = (x: number, settle: boolean) => latest.current.onChange(clamp01((x - L.thumb / 2) / Math.max(1, latest.current.width - L.thumb)), settle);
    const pan = Gesture.Pan()
      .withTestId(`themeTrack:${label}`)
      .activeOffsetX([-space.xs, space.xs])
      .failOffsetY([-space.s, space.s])
      .onStart((e) => {
        runOnJS(report)(e.x, false);
      })
      .onUpdate((e) => {
        runOnJS(report)(e.x, false);
      })
      .onEnd((e) => {
        runOnJS(report)(e.x, true);
      });
    const tap = Gesture.Tap()
      .withTestId(`themeTap:${label}`)
      .onEnd((e, success) => {
        if (success) runOnJS(report)(e.x, true);
      });
    return Gesture.Exclusive(blocks ? pan.blocksExternalGesture(blocks) : pan, tap);
  }, [blocks, label]);
  const step = (by: number) => onChange(stepped(latest.current.value, by), true);
  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => step(event.nativeEvent.actionName === "increment" ? L.accessibilityStep : -L.accessibilityStep)}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={styles.track}
      >
        <View style={styles.bar}>{bar}</View>
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            { left: value * Math.max(0, width - L.thumb), backgroundColor: thumbColor ?? ink.white, borderWidth: thumbColor ? L.knobBorder : StyleSheet.hairlineWidth, borderColor: thumbColor ? ink.white : themeEditorInk.knobOutline },
          ]}
        />
      </View>
    </GestureDetector>
  );
}

export function LightnessBar({ theme, index, onChange, blocks }: { theme: ProfileTheme; index: number; onChange: Change } & Blocks) {
  const stop = theme.stops[index]!;
  const steps = useMemo(() => lightnessSteps(stop, L.lightnessSteps), [stop.x, stop.y]);
  const latest = useRef(theme);
  latest.current = theme;
  const change = (value: number, settle: boolean) => onChange(withStopLightness(latest.current, index, value), settle);
  return (
    <Track
      label={t(`Brightness`)}
      value={stopLightness(stop)}
      thumbColor={colorHex(stop.color)}
      blocks={blocks}
      onChange={change}
      bar={
        <View style={styles.lightness}>
          {steps.map((color, i) => (
            <View key={i} style={[styles.fill, { backgroundColor: color }]} />
          ))}
        </View>
      }
    />
  );
}

export function ThemeSlider({ title, value, onChange, blocks }: { title: string; value: number; onChange: (value: number, settle: boolean) => void } & Blocks) {
  const theme = useTheme();
  return (
    <View style={styles.sliderRow}>
      <Text style={[font.body, { color: theme.label }]}>{title}</Text>
      <Track
        label={title}
        value={value}
        onChange={onChange}
        blocks={blocks}
        bar={
          <View style={[styles.slider, { backgroundColor: theme.separator }]}>
            <View style={[styles.sliderFill, { width: `${value * 100}%`, backgroundColor: theme.formAccent }]} />
          </View>
        }
      />
    </View>
  );
}

export function DirectionDial({ angle, onChange, blocks }: { angle: number; onChange: (angle: number, settle: boolean) => void } & Blocks) {
  const theme = useTheme();
  const latest = useRef({ angle, onChange });
  latest.current = { angle, onChange };
  const pan = useMemo(() => {
    const report = (x: number, y: number, settle: boolean) => latest.current.onChange(dialAngle(x - L.dial / 2, y - L.dial / 2, L.dialSnap, L.dialNotch), settle);
    const cancel = (success: boolean) => {
      if (!success) latest.current.onChange(latest.current.angle, true);
    };
    const gesture = Gesture.Pan()
      .withTestId("themeDial")
      .minDistance(0)
      .onBegin((e) => {
        runOnJS(report)(e.x, e.y, false);
      })
      .onUpdate((e) => {
        runOnJS(report)(e.x, e.y, false);
      })
      .onEnd((e) => {
        runOnJS(report)(e.x, e.y, true);
      })
      .onFinalize((_e, success) => {
        runOnJS(cancel)(success);
      });
    return blocks ? gesture.blocksExternalGesture(blocks) : gesture;
  }, [blocks]);
  const step = (by: number) => onChange((Math.round(angle / L.dialNotch) + by) * L.dialNotch, true);
  return (
    <GestureDetector gesture={pan}>
      <View
        testID="themeDial"
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t(`Direction`)}
        accessibilityValue={{ text: `${Math.round(angle)}°` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => step(event.nativeEvent.actionName === "increment" ? 1 : -1)}
        style={[styles.dial, { backgroundColor: theme.groupFill, borderColor: theme.separator }]}
      >
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${angle}deg` }] }]}>
          <View style={[styles.hand, { backgroundColor: theme.formAccent }]} />
        </View>
        <View pointerEvents="none" style={[styles.hub, { backgroundColor: theme.formAccent }]} />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  pad: { width: L.pad, height: L.pad, alignSelf: "center" },
  knob: { position: "absolute", width: L.knob, height: L.knob, borderRadius: capsule(L.knob), borderColor: ink.white },
  halo: { position: "absolute", left: -L.knobHalo - L.knobBorder, top: -L.knobHalo - L.knobBorder, right: -L.knobHalo - L.knobBorder, bottom: -L.knobHalo - L.knobBorder, borderRadius: capsule(L.knob + L.knobHalo * 2), borderWidth: StyleSheet.hairlineWidth * 2, borderColor: themeEditorInk.knobOutline },
  track: { height: L.thumb + space.s, justifyContent: "center" },
  bar: { marginHorizontal: L.thumb / 2 },
  thumb: { position: "absolute", width: L.thumb, height: L.thumb, borderRadius: capsule(L.thumb) },
  lightness: { height: L.lightnessHeight, borderRadius: capsule(L.lightnessHeight), overflow: "hidden", flexDirection: "row" },
  fill: { flex: 1 },
  slider: { height: L.track, borderRadius: capsule(L.track), overflow: "hidden" },
  sliderFill: { height: L.track },
  sliderRow: { paddingHorizontal: settingsLayout.rowInset, paddingTop: space.m, paddingBottom: space.xs, gap: space.xs },
  dial: { width: L.dial, height: L.dial, borderRadius: capsule(L.dial), borderWidth: StyleSheet.hairlineWidth * 2, alignItems: "center", justifyContent: "center" },
  hand: { position: "absolute", left: L.dial / 2 - L.dialHand / 2 - StyleSheet.hairlineWidth * 2, top: space.xs, width: L.dialHand, height: L.dial / 2 - space.xs, borderRadius: capsule(L.dialHand) },
  hub: { width: L.dialHub, height: L.dialHub, borderRadius: capsule(L.dialHub) },
});
