import type { ReactNode } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { CheckBoxFace } from "./Checkbox";
import { checkboxA11y, spaceActivates, tapActivates } from "./a11y";
import { useLiveWhile, useClosing } from "./Closing";

export function CheckTarget({
  value,
  onChange,
  label,
  hint,
  disabled,
  style,
  children,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const closing = useClosing();
  const active = !disabled && !closing;
  const live = useLiveWhile(closing);
  const toggle = () => onChange(!value);
  return (
    <Pressable
      disabled={!active}
      focusable={active}
      onPress={live(toggle)} onAccessibilityTap={!active ? undefined : tapActivates(live(toggle))}
      onKeyDown={active ? live(spaceActivates(toggle)) : undefined}
      {...checkboxA11y(value, disabled, label)}
      accessibilityHint={hint}
      style={style}
    >
      {children}
    </Pressable>
  );
}

export function CheckMark({ value, disabled }: { value: boolean; disabled?: boolean }) {
  return <CheckBoxFace on={value} disabled={disabled} />;
}
