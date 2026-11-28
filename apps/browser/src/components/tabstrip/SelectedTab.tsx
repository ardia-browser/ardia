import { Fragment, useContext } from "react";
import { Animated } from "react-native";
import { clippedContinuousCorners, continuousCorners, Surface } from "../ui";
import { useTheme } from "../ui/theme";
import type { useEasedColor } from "../ui/toolbarColors";
import { useDevicePixelsPerRootPoint } from "../../state/settings/interfaceScale";
import { snappedToGrid } from "../../lib/interfaceScale";
import { FloatingStrip } from "./context";
import { selectedTabEdges } from "./selectedTabShape";
import { CHIP_HAIRLINE, FLARE, ITEM_HEIGHT, ITEM_TOP, RIM_HEIGHT, RIM_WIDTH, STRIP_COLORS, tabRadius, TAB_TOP, TOP_STRIP_HEIGHT } from "./tokens";

type Fill = string | ReturnType<typeof useEasedColor>;

type Size = number | Animated.Value | Animated.AnimatedAddition<number> | Animated.AnimatedSubtraction<number>;
const plus = (size: Size, k: number): Size => (typeof size === "number" ? size + k : Animated.add<number>(size, k));

function snapped(size: Size, pixelsPerPoint: number): Size {
  if (typeof size === "number") return snappedToGrid(size, pixelsPerPoint);
  const pixel = 1 / pixelsPerPoint;
  const halfUp = Animated.add<number>(size, pixel / 2);
  return Animated.subtract<number>(halfUp, Animated.modulo(halfUp, pixel));
}

export function SelectedTab({ width, band, opaque = false }: { width: Size; band: Fill | null; opaque?: boolean }) {
  const theme = useTheme();
  const floating = useContext(FloatingStrip);
  const pixelsPerPoint = useDevicePixelsPerRootPoint();
  if (floating) {
    const card = {
      position: "absolute" as const,
      left: 0,
      top: ITEM_TOP,
      width,
      height: ITEM_HEIGHT,
      ...clippedContinuousCorners(tabRadius()),
    };
    return (
      <>
        {opaque && <Animated.View pointerEvents="none" style={{ ...card, backgroundColor: theme.windowTint[0] }} />}
        <Animated.View
          pointerEvents="none"
          style={{
            ...card,
            borderWidth: CHIP_HAIRLINE,
            borderColor: STRIP_COLORS[theme.dark ? "dark" : "light"].floatingTabBorder,
            backgroundColor: theme.card,
          }}
        />
      </>
    );
  }
  const { inset, flare } = selectedTabEdges(pixelsPerPoint);
  const body = snapped(plus(width, -2 * inset), pixelsPerPoint);
  const fills: Fill[] = [...(opaque ? [theme.windowTint[0]] : []), theme.card, ...(band ? [band] : [])];
  const rim = STRIP_COLORS[theme.dark ? "dark" : "light"].selectedRim;
  return (
    <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width, height: TOP_STRIP_HEIGHT }}>
      {fills.map((fill, i) => (
        <Fragment key={i}>
          <Animated.View style={{ position: "absolute", left: inset, top: TAB_TOP, width: body, height: TOP_STRIP_HEIGHT - TAB_TOP, overflow: "hidden" }}>
            <Animated.View
              style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: -tabRadius() * 2, ...continuousCorners(tabRadius()), backgroundColor: fill }}
            />
          </Animated.View>
          <Flare x={inset - flare} width={flare} side="left" color={fill} />
          <Flare x={plus(body, inset)} width={flare} side="right" color={fill} />
        </Fragment>
      ))}
      <Animated.View style={{ position: "absolute", left: 0, top: TAB_TOP - 0.5, width, height: RIM_HEIGHT * 2 }}>
        <Surface cornerRadius={tabRadius() + 0.5} borderWidth={RIM_WIDTH} borderColors={[...rim, rim.at(-1)!]} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} />
      </Animated.View>
    </Animated.View>
  );
}

function Flare({ x, width, side, color }: { x: Size; width: number; side: "left" | "right"; color: Fill }) {
  const outer = FLARE * 2;
  return (
    <Animated.View style={{ position: "absolute", left: x, top: TOP_STRIP_HEIGHT - FLARE, width, height: FLARE, overflow: "hidden" }}>
      <Animated.View
        style={{
          position: "absolute",
          ...(side === "left" ? { right: -FLARE } : { left: -FLARE }),
          top: -outer,
          width: outer * 2,
          height: outer * 2,
          borderRadius: outer,
          borderWidth: FLARE,
          borderColor: color,
        }}
      />
    </Animated.View>
  );
}
