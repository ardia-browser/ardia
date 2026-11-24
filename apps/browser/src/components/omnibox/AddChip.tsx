import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Symbol, Text, useHover, useTheme } from "../ui";
import { GlassFill, useGlass } from "../ui/Glass";
import { ADD_CHIP } from "./tokens";

export const AddChip = memo(function AddChip({ onPress }: { onPress(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const glass = useGlass();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>
        {({ pressed }) => (
          <View
            style={{
              height: ADD_CHIP.height,
              borderRadius: ADD_CHIP.radius,
              borderWidth: glass ? 0 : ADD_CHIP.border,
              borderColor: theme.chipBorder,
              backgroundColor: glass ? undefined : pressed ? theme.toolbarPressed : hovered ? theme.rowHover : undefined,
              flexDirection: "row",
              alignItems: "center",
              paddingLeft: ADD_CHIP.left,
              paddingRight: ADD_CHIP.right,
              gap: ADD_CHIP.gap,
            }}
          >
            {glass ? <GlassFill radius={ADD_CHIP.radius} state={pressed ? "pressed" : hovered ? "lit" : "rest"} /> : null}
            {glass && pressed ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: ADD_CHIP.radius, backgroundColor: theme.toolbarPressed }]} /> : null}
            <Symbol name="arrow.up.right" size={ADD_CHIP.glyph} weight="medium" color={theme.chipText} style={{ width: ADD_CHIP.glyphBox, height: ADD_CHIP.glyphBox }} />
            <Text tone="chipText" ardiaCentersCapitals>Open a tab or file</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
});
