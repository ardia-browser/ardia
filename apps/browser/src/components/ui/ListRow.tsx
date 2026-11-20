import { useRef, useState, type ReactNode } from "react";
import { markHoverProps } from "../../lib/hoverMarks";
import { Pressable, View, type GestureResponderEvent } from "react-native";
import { useTheme } from "./theme";
import { ink, radius, space } from "./tokens";
import { HoverFill } from "./HoverFill";

const SELECTION_EDGE = 1;

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
      <Pressable onPress={onPress} onPressIn={onPressIn}>
        {({ pressed }) => (
          <View
            style={{
              height,
              paddingHorizontal: space.m,
              borderRadius: radius.tile,
              flexDirection: "row",
              alignItems: "center",
              gap: space.m,
              backgroundColor: selected ? (selectedTone === "accent" ? theme.formSelection : theme.rowSelected) : undefined,
              borderWidth: selectedTone === "accent" ? SELECTION_EDGE : 0,
              borderColor: selected ? theme.formSelectionEdge : ink.clear,
            }}
          >
            <HoverFill shown={hovered && !selected} instant={selected} color={theme.rowHover} radius={radius.tile} />
            {typeof children === "function" ? children({ hovered, pressed, selected }) : children}
          </View>
        )}
      </Pressable>
    </View>
  );
}
