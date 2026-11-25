import { View } from "react-native";
import type { BreatheProps } from "@ardia-real/shell";

const SINE_IN_OUT = "cubic-bezier(0.37, 0, 0.63, 1)";
const FILL = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" } as const;
const styled = new Set<string>();

function keyframesFor(opacity: readonly [number, number], scale: readonly [number, number]) {
  const name = `ardia-breathe-${[...opacity, ...scale].map((n) => String(n).replace(/\W/g, "_")).join("-")}`;
  if (typeof document === "undefined" || styled.has(name)) return name;
  styled.add(name);
  const style = document.createElement("style");
  style.textContent = `@keyframes ${name} { from { opacity: ${opacity[0]}; transform: scale(${scale[0]}); } to { opacity: ${opacity[1]}; transform: scale(${scale[1]}); } }`;
  document.head.append(style);
  return name;
}

export function Breathe({ running, cycleMs, opacityRange, scaleRange, style, children, ...props }: BreatheProps) {
  const name = keyframesFor(opacityRange, scaleRange);
  const motion = running
    ? { animation: `${name} ${cycleMs / 2}ms ${SINE_IN_OUT} infinite alternate` }
    : { opacity: opacityRange[0], transform: `scale(${scaleRange[0]})` };
  return (
    <View {...props} pointerEvents="none" style={style}>
      <div style={{ ...FILL, ...motion }}>{children}</div>
    </View>
  );
}
