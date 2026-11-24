import { Fragment, useContext } from "react";
import { Animated } from "react-native";
import { Surface } from "../ui";
import { useTheme } from "../ui/theme";
import type { useEasedColor } from "../ui/toolbarColors";
import { FloatingStrip } from "./context";
import { CHIP_HAIRLINE, FLARE, ITEM_HEIGHT, ITEM_TOP, RIM_HEIGHT, RIM_WIDTH, STRIP_COLORS, tabRadius, TAB_TOP, TOP_STRIP_HEIGHT } from "./tokens";

type Fill = string | ReturnType<typeof useEasedColor>;

type Size = number | Animated.Value | Animated.AnimatedAddition<number>;
const plus = (size: Size, k: number): Size => (typeof size === "number" ? size + k : Animated.add<number>(size, k));

export function SelectedTab({ width, band, opaque = false }: { width: Size; band: Fill | null; opaque?: boolean }) {
  const theme = useTheme();
  const floating = useContext(FloatingStrip);
  if (floating) {
    const card = {
      position: "absolute" as const,
      left: 0,
      top: ITEM_TOP,
      width,
      height: ITEM_HEIGHT,
      borderRadius: tabRadius(),
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
  const body = plus(width, -1);
  const fills: Fill[] = [...(opaque ? [theme.windowTint[0]] : []), theme.card, ...(band ? [band] : [])];
  const rim = STRIP_COLORS[theme.dark ? "dark" : "light"].selectedRim;
  return (
    <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width, height: TOP_STRIP_HEIGHT }}>
      {fills.map((fill, i) => (
        <Fragment key={i}>
          <Animated.View
            style={{
              position: "absolute",
              left: 0.5,
              top: TAB_TOP,
              width: body,
              height: TOP_STRIP_HEIGHT - TAB_TOP,
              borderTopLeftRadius: tabRadius(),
              borderTopRightRadius: tabRadius(),
              backgroundColor: fill,
            }}
          />
          <Flare x={0.5 - FLARE} side="left" color={fill} />
          <Flare x={plus(body, 0.5)} side="right" color={fill} />
        </Fragment>
      ))}
      <Animated.View style={{ position: "absolute", left: 0, top: TAB_TOP - 0.5, width, height: RIM_HEIGHT * 2 }}>
        <Surface cornerRadius={tabRadius() + 0.5} borderWidth={RIM_WIDTH} borderColors={[...rim, rim.at(-1)!]} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} />
      </Animated.View>
    </Animated.View>
  );
}

function Flare({ x, side, color }: { x: Size; side: "left" | "right"; color: Fill }) {
  const outer = FLARE * 2;
  return (
    <Animated.View style={{ position: "absolute", left: x, top: TOP_STRIP_HEIGHT - FLARE, width: FLARE, height: FLARE, overflow: "hidden" }}>
      <Animated.View
        style={{
          position: "absolute",
          left: side === "left" ? -outer : FLARE - outer,
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
