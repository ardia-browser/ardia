import type { SearchScope } from "@ardia/core";
import { useLayoutEffect, useRef, type ComponentProps, type RefObject } from "react";
import { findNodeHandle, TextInput } from "react-native";
import { useTheme } from "../ui";
import { barFieldMarks } from "../../state/omnibox/barMarks";
import { PASTED_TYPES } from "./omniboxKeys";
import { useHeldEscape } from "../ui/fieldKeys";
import { useClaimFollowsFocus, type FocusClaim } from "./claimFollowsFocus";
import { useRevertRepair } from "./useRevertRepair";
import { BAR, BAR_TYPE } from "./tokens";

type InputProps = ComponentProps<typeof TextInput>;

export function BarField({
  inputRef,
  variant,
  floating,
  scope,
  incognito,
  focusEcho,
  onSelection,
  claim,
  ...events
}: {
  inputRef: RefObject<TextInput | null>;
  focusEcho: RefObject<boolean>;
  onSelection(next: { start: number; end: number }): void;
  variant: "panel" | "hero" | "sidebar";
  floating: boolean;
  scope: SearchScope | null;
  incognito: boolean;
  claim?: FocusClaim;
} & Pick<InputProps, "value" | "onLayout" | "onChangeText" | "onSubmitEditing" | "onFocus" | "onBlur" | "keyDownEvents" | "onKeyDown" | "keyUpEvents" | "onKeyUp">) {
  const theme = useTheme();
  const heldEscape = useHeldEscape();
  const nativeText = useRef<string | null>(null);
  useLayoutEffect(() => {
    const native = nativeText.current;
    if (native !== null && events.value !== undefined && events.value !== native) barFieldMarks.write(variant, events.value.length, native.length);
  }, [events.value]);
  const tag = () => findNodeHandle(inputRef.current);
  useLayoutEffect(() => {
    const mounted = tag();
    barFieldMarks.field("mount", variant, mounted);
    return () => barFieldMarks.field("unmount", variant, mounted);
  }, []);
  const claimOnFocus = useClaimFollowsFocus(inputRef, claim);
  const repair = useRevertRepair(inputRef, variant, events.value, events.onChangeText, onSelection);
  const type = variant === "hero" ? BAR_TYPE.heroField : variant === "sidebar" || floating ? BAR_TYPE.floatingField : BAR_TYPE.panelField;
  return (
    <TextInput
      ref={inputRef}
      {...events}
      {...heldEscape.upProps}
      onKeyDown={(e) => heldEscape.down(e) || events.onKeyDown?.(e)}
      onChangeText={repair.changed}
      onFocus={(e) => (barFieldMarks.field("focus", variant, tag()), claimOnFocus(), events.onFocus?.(e))}
      onBlur={(e) => (barFieldMarks.field("blur", variant, tag()), events.onBlur?.(e))}
      onLayout={(e) => (barFieldMarks.field(`layout ${Math.round(e.nativeEvent.layout.x)},${Math.round(e.nativeEvent.layout.y)} ${Math.round(e.nativeEvent.layout.width)}x${Math.round(e.nativeEvent.layout.height)}`, variant, tag()), events.onLayout?.(e))}
      onChange={(e) => {
        nativeText.current = e.nativeEvent.text;
        barFieldMarks.change(variant, e.nativeEvent.eventCount, e.nativeEvent.text.length);
      }}
      onSelectionChange={(e) => {
        const next = e.nativeEvent.selection;
        repair.selected(next);
        const length = events.value?.length ?? 0;
        if (focusEcho.current) {
          const atEnd = next.start === length && next.end === length;
          if (atEnd || (next.start === 0 && next.end === length)) {
            if (atEnd) focusEcho.current = false;
            return;
          }
          focusEcho.current = false;
        }
        onSelection(next);
      }}
      placeholder={scope ? `Search ${scope.name}` : incognito ? "Search privately or enter address" : "Search or enter address"}
      placeholderTextColor={theme.placeholder}
      pastedTypes={PASTED_TYPES}
      selectionColor={theme.selection}
      enableFocusRing={false}
      ardiaCentersCapitals
      style={{
        flex: 1,
        ...type,
        color: theme.textPrimary,
        paddingVertical: 0,
        marginTop: variant === "panel" ? BAR.panelFieldLift : 0,
      }}
    />
  );
}
