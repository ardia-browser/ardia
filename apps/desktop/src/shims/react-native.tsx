import { forwardRef, useCallback, useLayoutEffect, useRef, type ComponentProps, type ForwardedRef, type KeyboardEvent } from "react";
import { unstable_batchedUpdates as batchedUpdates } from "react-dom";
import { Animated as WebAnimated, StyleSheet as WebStyleSheet, TextInput as WebTextInput, UIManager } from "react-native-web";
import { watchLayout } from "./web/mountLayout";
import { handsKeyboardOnFocus } from "../pageFocus";

export * from "react-native-web";
export { MacPressable as Pressable, MacView as View } from "./web/motion/macView";
export { MacText as Text } from "./web/MacText";
export { ScaledImage as Image } from "./web/ScaledImage";

export const unstable_batchedUpdates = batchedUpdates;

type Measured = (x: number, y: number, width: number, height: number) => void;
type MeasuredOnPage = (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void;
const pageMeasureInWindow = (UIManager as unknown as { measureInWindow: (node: Element, callback: Measured) => void }).measureInWindow;
const layoutMeasure = (UIManager as unknown as { measure: (node: Element, callback: MeasuredOnPage) => void }).measure;
Object.assign(UIManager, {
  measure(node: Element, callback: MeasuredOnPage) {
    layoutMeasure(node, (x, y, width, height) => {
      const box = node.getBoundingClientRect();
      callback(x, y, width, height, box.left + window.scrollX, box.top + window.scrollY);
    });
  },
  measureInWindow(node: Element, callback: Measured) {
    pageMeasureInWindow(node, (x, y, width, height) => {
      const frame = node.closest?.(".ardia-window")?.getBoundingClientRect();
      callback(x - (frame?.left ?? 0), y - (frame?.top ?? 0), width, height);
    });
  },
});

class JsDrivenValue extends WebAnimated.Value {
  constructor(value: number, config?: { useNativeDriver?: boolean }) {
    super(value, config ? { ...config, useNativeDriver: false } : undefined);
  }
}

type Driven = { useNativeDriver?: boolean };
const jsDriven = <C extends Driven | undefined>(config: C): C => (config ? { ...config, useNativeDriver: false } : config);

export const Animated = {
  ...WebAnimated,
  Value: JsDrivenValue,
  timing: (value: never, config: Driven) => WebAnimated.timing(value, jsDriven(config) as never),
  spring: (value: never, config: Driven) => WebAnimated.spring(value, jsDriven(config) as never),
  decay: (value: never, config: Driven) => WebAnimated.decay(value, jsDriven(config) as never),
  event: (mapping: never, config?: Driven) => WebAnimated.event(mapping, jsDriven(config) as never),
} as unknown as typeof WebAnimated;

export const findNodeHandle = (component: unknown) => {
  if (component instanceof Element) return component as unknown as number;
  const getter = (component as { getScrollableNode?: () => unknown } | null)?.getScrollableNode;
  if (typeof getter === "function") {
    const inner = getter.call(component);
    if (inner instanceof Element) return inner as unknown as number;
  }
  return null;
};

type KeyMatch = { key: string; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean };
type MacTextInputProps = ComponentProps<typeof WebTextInput> & {
  keyDownEvents?: KeyMatch[];
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  cursorColor?: string | null;
  dataSet?: Record<string, string>;
};

const MODIFIERS = ["metaKey", "shiftKey", "altKey", "ctrlKey"] as const;
type KeyPress = Pick<KeyboardEvent, "key" | "repeat" | "keyCode" | (typeof MODIFIERS)[number]> & { nativeEvent?: { isComposing?: boolean } };
const matches = (e: KeyPress, wanted: KeyMatch) =>
  e.key === wanted.key && MODIFIERS.every((m) => wanted[m] === undefined || !!e[m] === wanted[m]);
const IME_PROCESS_KEY_CODE = 229;

export function fieldKeyDown(e: KeyPress, keyDownEvents?: KeyMatch[]): "ignore" | "swallow" | "pass" | "handle" {
  if (e.nativeEvent?.isComposing || e.keyCode === IME_PROCESS_KEY_CODE) return "ignore";
  const wanted = keyDownEvents?.some((match) => matches(e, match)) ?? false;
  if (e.key === "Escape" && e.repeat) return wanted ? "swallow" : "ignore";
  if (!keyDownEvents) return "pass";
  return wanted ? "handle" : "ignore";
}

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export const NATIVE_CHANGE = Symbol("ardiaNativeChange");

export function fieldLook(style: unknown, selectionColor: unknown, cursorColor: unknown, caretHidden?: boolean) {
  const ink = (WebStyleSheet.flatten(style as never) as { color?: unknown } | undefined)?.color;
  const selection = typeof selectionColor === "string" && selectionColor ? { "--ardia-selection-bg": selectionColor, ...(typeof ink === "string" && ink ? { "--ardia-selection-fg": ink } : {}) } : null;
  const caret = typeof cursorColor === "string" && cursorColor && !caretHidden ? { caretColor: cursorColor } : null;
  return { selection: !!selection, style: selection || caret ? [style, { ...selection, ...caret }] : style };
}

export const TextInput = forwardRef<unknown, MacTextInputProps>(function MacTextInput({ keyDownEvents, onKeyDown, cursorColor, ...props }, ref) {
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const action = fieldKeyDown(e, keyDownEvents);
    if (action === "swallow" || action === "handle") e.preventDefault();
    if (action === "pass" || action === "handle") onKeyDown?.(e);
  };
  const native = useRef({ changeText: props.onChangeText, selectionChange: props.onSelectionChange });
  native.current = { changeText: props.onChangeText, selectionChange: props.onSelectionChange };
  const field = useRef<HTMLInputElement | null>(null);
  const layoutHandler = useRef(props.onLayout);
  layoutHandler.current = props.onLayout;
  const measured = !!props.onLayout;
  useLayoutEffect(() => (measured ? watchLayout(field.current, () => layoutHandler.current as never, window) : undefined), [measured]);
  const attach = useCallback((node: HTMLInputElement | null) => {
    field.current = node;
    if (node) handsKeyboardOnFocus(node);
    if (node)
      Object.assign(node, {
        setSelection: (start: number, end: number) => node.setSelectionRange(start, end),
        [NATIVE_CHANGE]: (text: string, selection: { start: number; end: number }) => {
          native.current.changeText?.(text);
          native.current.selectionChange?.({ nativeEvent: { selection } } as never);
        },
      });
    assignRef(ref, node);
  }, [ref]);
  const Input = WebTextInput as unknown as React.ComponentType<Record<string, unknown>>;
  const onChange = (e: { target: EventTarget | null }) => {
    const field = e.target as HTMLInputElement | null;
    if (field && props.onSelectionChange) props.onSelectionChange({ nativeEvent: { selection: { start: field.selectionStart ?? 0, end: field.selectionEnd ?? 0 } } } as never);
    (props.onChange as ((event: unknown) => void) | undefined)?.(e);
  };
  const look = fieldLook(props.style, props.selectionColor, cursorColor, props.caretHidden);
  return <Input {...props} style={look.style} dataSet={look.selection ? { ...props.dataSet, ardiaSelection: "" } : props.dataSet} onLayout={undefined} ref={attach} onChange={onChange} onKeyPress={onKeyDown || keyDownEvents ? handleKeyDown : props.onKeyPress} />;
});
