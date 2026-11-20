import { useEffect, useMemo, useRef } from "react";
import { Animated, View } from "react-native";
import { Symbol, useTheme } from "../ui";
import { reduceMotion } from "../ui/reduceMotion";
import { LIBRARY_MOTION } from "./motion";
import { LIBRARY } from "./tokens";
import type { LibraryGlyph as Glyph } from "./useLibraryGlyph";

const F = LIBRARY.footer;
const S = LIBRARY_MOTION.swap;
const BOX_NAME = F.symbols.idle;

type Family = "box" | "status";

const familyOf = (glyph: Glyph): Family => (glyph === "idle" || glyph === "open" ? "box" : "status");

function useSwap(on: boolean) {
  const [opacity, scale] = useMemo(() => [new Animated.Value(on ? 1 : 0), new Animated.Value(on ? 1 : S.scale)], []);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    opacity.stopAnimation();
    scale.stopAnimation();
    if (reduceMotion() === true) {
      scale.setValue(1);
      Animated.timing(opacity, { toValue: on ? 1 : 0, ...S.fade, useNativeDriver: true }).start();
      return;
    }
    if (on) {
      scale.setValue(S.scale);
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, ...S.in, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, ...S.out, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(scale, { toValue: S.scale, ...S.out, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, ...S.out, useNativeDriver: true }),
      ]).start();
    }
  }, [on, opacity, scale]);
  return { opacity, transform: [{ scale }] };
}

function useLid(open: boolean) {
  const lid = useMemo(() => new Animated.Value(open ? 1 : 0), []);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    lid.stopAnimation();
    if (reduceMotion() === true) return lid.setValue(open ? 1 : 0);
    Animated.spring(lid, { toValue: open ? 1 : 0, ...(open ? LIBRARY_MOTION.lid.open : LIBRARY_MOTION.lid.close), useNativeDriver: true }).start();
  }, [open, lid]);
  return useMemo(
    () => ({
      transform: [
        { translateX: lid.interpolate({ inputRange: [0, 1], outputRange: [0, F.lid.shift] }) },
        { translateY: lid.interpolate({ inputRange: [0, 1], outputRange: [0, F.lid.lift] }) },
        { rotate: lid.interpolate({ inputRange: [0, 1], outputRange: ["0deg", `${F.lid.tilt}deg`] }) },
      ],
    }),
    [lid],
  );
}

export function LibraryGlyph({ glyph, frame, bounce }: { glyph: Glyph; frame: number; bounce: number }) {
  const theme = useTheme();
  const family = familyOf(glyph);
  const settled = useRef(family);
  const lastStatus = useRef<Glyph>(family === "status" ? glyph : "downloading");
  if (family === "status") lastStatus.current = glyph;
  const replace = family === "status" && settled.current === "status";
  useEffect(() => {
    settled.current = family;
  }, [family]);
  const box = useSwap(family === "box");
  const status = useSwap(family === "status");
  const lid = useLid(glyph === "open");
  const mid = frame / 2;
  const boxTop = mid + F.box.top;
  const split = mid + F.box.split;
  const boxLeft = mid + F.box.left;
  const symbol = (top: number, left: number) => (
    <Symbol name={BOX_NAME} size={F.glyph} color={theme.icon} style={{ position: "absolute", top: -top, left: -left, width: frame, height: frame }} />
  );
  return (
    <View pointerEvents="none" style={{ width: frame, height: frame }}>
      <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: frame, height: frame }, box]}>
        <View style={{ position: "absolute", left: 0, top: split, width: frame, height: frame - split, overflow: "hidden" }}>{symbol(split, 0)}</View>
        <Animated.View style={[{ position: "absolute", left: boxLeft, top: boxTop, width: F.box.width, height: split - boxTop, overflow: "hidden" }, lid]}>
          {symbol(boxTop, boxLeft)}
        </Animated.View>
      </Animated.View>
      <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: frame, height: frame }, status]}>
        <Symbol name={F.symbols[lastStatus.current]} size={F.glyph} color={theme.icon} bounce={bounce} replace={replace} style={{ width: frame, height: frame }} />
      </Animated.View>
    </View>
  );
}
