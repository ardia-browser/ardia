import { useLayoutEffect, useRef } from "react";
import { View, type ViewProps } from "react-native";
import { attachWebWheelArea } from "../../../../browser/src/platform/webWheelSteer";

export type WheelAreaProps = ViewProps & { onStep?: (direction: 1 | -1) => void };

export function WheelArea({ onStep, style, children, ...props }: WheelAreaProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const latest = useRef(onStep);
  latest.current = onStep;
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    return attachWebWheelArea(node, () => latest.current);
  }, []);
  return (
    <div ref={host} data-ardia-wheel-area="" style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0 }}>
      <View {...props} style={[{ flex: 1 }, style]}>
        {children}
      </View>
    </div>
  );
}
