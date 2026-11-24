import type { ReactNode, RefObject } from "react";
import { Pressable, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import { slopToReach, slotAround } from "./hitTarget";
import { screenReaderActions } from "./screenReaderActions";
import { usePressStyle } from "./pressFeedback";
import { GlyphPressFace, type PressDims } from "./PressInPlace";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";
import { glyphSlot } from "./tokens";

export type SlotLayout = "slot" | "slop";

type SlotProps = { visual?: number; layout?: SlotLayout; style?: StyleProp<ViewStyle> };

function slotPlacement(visual: number, layout: SlotLayout) {
  return layout === "slot" ? { box: slotAround(visual), slop: undefined } : { box: { width: visual, height: visual, alignItems: "center" as const, justifyContent: "center" as const }, slop: slopToReach(visual) };
}

type FieldAccessoryProps = SlotProps & {
  icon: SymbolName;
  label: string;
  color: string;
  onPress: () => void;
  hint?: string;
  disabled?: boolean;
  buttonRef?: RefObject<ViewInstance | null>;
  testID?: string;
};

export const FIELD_ACCESSORY_GLYPH = glyphSlot.field;

export function FieldAccessory({ icon, label, color, onPress, hint, disabled = false, visual = FIELD_ACCESSORY_GLYPH, layout = "slot", style, buttonRef, testID }: FieldAccessoryProps) {
  const { box, slop } = slotPlacement(visual, layout);
  const pressStyle = usePressStyle("icon", { disabled, style: [box, style] });
  return (
    <Pressable ref={buttonRef} testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ disabled }} disabled={disabled} hitSlop={slop} onPress={onPress} style={pressStyle}>
      <Symbol name={icon} size={FIELD_ACCESSORY_GLYPH} color={color} />
    </Pressable>
  );
}

export type ToggleIconRole = "switch" | "button";

type ToggleIconButtonProps = SlotProps & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  role?: ToggleIconRole;
  disabled?: boolean;
  testID?: string;
  onPressIn?: () => void;
  onLongPress?: () => void;
  longPressLabel?: string;
  dims?: PressDims;
  children: ReactNode;
};

export function ToggleIconButton({ checked, onChange, label, hint, role = "switch", disabled = false, visual = glyphSlot.icon, layout = "slot", style, testID, onPressIn, onLongPress, longPressLabel, dims = "button", children }: ToggleIconButtonProps) {
  const { box, slop } = slotPlacement(visual, layout);
  const longPressAction = onLongPress ? screenReaderActions([{ name: "longpress", label: longPressLabel, run: onLongPress }]) : {};
  const dimsButton = dims === "button";
  const pressStyle = usePressStyle("icon", { disabled, style: [box, style] });
  return (
    <Pressable
      testID={testID}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={role === "switch" ? { checked, disabled } : { selected: checked, disabled }}
      disabled={disabled}
      hitSlop={slop}
      {...longPressAction}
      onPress={() => onChange(!checked)}
      onPressIn={onPressIn}
      onLongPress={onLongPress}
      style={dimsButton ? pressStyle : [box, style]}
    >
      {dimsButton ? children : <GlyphPressFace testID={`toggleIconButton:${label}`} disabled={disabled}>{children}</GlyphPressFace>}
    </Pressable>
  );
}
