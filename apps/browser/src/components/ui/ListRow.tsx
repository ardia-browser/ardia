import { useRef, useState, type ReactNode } from "react";
import { tapActivates } from "./a11y";
import { markHoverProps } from "../../lib/hoverMarks";
import { Pressable, View, type GestureResponderEvent } from "react-native";
import { useTheme } from "./theme";
import { radius, space } from "./tokens";
import { HoverFill } from "./HoverFill";
import { useLiveWhile, useClosing } from "./Closing";

export type ListRowState = { hovered: boolean; pressed: boolean; selected: boolean };

export function ListRow({
  selected = false,
  selectedTone = "row",
  height,
  onPress,
  onPressIn,
  onHover,
  children,
}: {
  selected?: boolean;
  selectedTone?: "row" | "accent";
  height?: number;
  onPress?: (event: GestureResponderEvent) => void;
  onPressIn?: (event: GestureResponderEvent) => void;
  onHover?: (hovered: boolean) => void;
  children: ReactNode | ((state: ListRowState) => ReactNode);
}) {
  const theme = useTheme();
  const closing = useClosing();
  const live = useLiveWhile(closing);
  const [hovered, setHovered] = useState(false);
  const notify = useRef(onHover);
  notify.current = onHover;
  const [hoverProps] = useState(() =>
    markHoverProps({
      onMouseEnter: () => {
        setHovered(true);
        notify.current?.(true);
      },
      onMouseLeave: () => {
        setHovered(false);
        notify.current?.(false);
      },
    }),
  );
  return (
    <View {...hoverProps}>
      <Pressable disabled={closing} onPress={live(onPress)} onAccessibilityTap={tapActivates(live(onPress))} onPressIn={live(onPressIn)} accessibilityRole={onPress ? "button" : undefined}>
        {({ pressed }) => (
          <View
            style={{
              height,
              paddingHorizontal: space.m,
              borderRadius: radius.tile,
              flexDirection: "row",
              alignItems: "center",
              gap: space.m,
              backgroundColor: !selected ? undefined : selectedTone !== "accent" ? theme.rowSelected : pressed && onPress ? theme.formAccentPressed : theme.formAccent,
            }}
          >
            {selected && selectedTone === "accent" ? null : <HoverFill shown={hovered || (pressed && !!onPress)} instant={pressed && !!onPress} color={pressed && onPress ? theme.popoverRowPressed : theme.rowHover} radius={radius.tile} />}
            {typeof children === "function" ? children({ hovered, pressed, selected }) : children}
          </View>
        )}
      </Pressable>
    </View>
  );
}
