import { forwardRef, useCallback, useRef, type ComponentProps, type ForwardedRef, type KeyboardEvent } from "react";
import { unstable_batchedUpdates as batchedUpdates } from "react-dom";
import {
  Animated as WebAnimated,
  PanResponder as WebPanResponder,
  TextInput as WebTextInput,
  UIManager,
  type GestureResponderEvent,
  type PanResponderCallbacks,
  type PanResponderGestureState,
} from "react-native-web";
import { currentPointer } from "./web/motion/pointer";

export * from "react-native-web";
export { MacPressable as Pressable, MacView as View } from "./web/motion/macView";
export { MacText as Text } from "./web/MacText";

export const unstable_batchedUpdates = batchedUpdates;

type Measured = (x: number, y: number, width: number, height: number) => void;
const pageMeasureInWindow = (UIManager as unknown as { measureInWindow: (node: Element, callback: Measured) => void }).measureInWindow;
Object.assign(UIManager, {
  measureInWindow(node: Element, callback: Measured) {
    pageMeasureInWindow(node, (x, y, width, height) => {
      const frame = node.closest?.(".ardia-window")?.getBoundingClientRect();
      callback(x - (frame?.left ?? 0), y - (frame?.top ?? 0), width, height);
    });
  },
});

function windowOffset(event: { currentTarget?: unknown; target?: unknown }): [number, number] {
  if (typeof document === "undefined") return [0, 0];
  const node = event.currentTarget instanceof Element ? event.currentTarget : event.target instanceof Element ? event.target : null;
  const frame = (node?.closest(".ardia-window") ?? document.querySelector(".ardia-window"))?.getBoundingClientRect();
  return frame ? [frame.left + window.scrollX, frame.top + window.scrollY] : [0, 0];
}

function windowEvent(event: GestureResponderEvent, ox: number, oy: number): GestureResponderEvent {
  const raw = event.nativeEvent;
  if (!raw) return event;
  const p = currentPointer();
  const nativeEvent = Object.create(raw, {
    ...(Number.isFinite(raw.pageX) ? { pageX: { value: raw.pageX - ox, enumerable: true } } : {}),
    ...(Number.isFinite(raw.pageY) ? { pageY: { value: raw.pageY - oy, enumerable: true } } : {}),
    altKey: { value: p?.altKey ?? false, enumerable: true },
    ctrlKey: { value: p?.ctrlKey ?? false, enumerable: true },
  });
  return Object.create(event, { nativeEvent: { value: nativeEvent, enumerable: true } });
}

function windowGesture(g: PanResponderGestureState, ox: number, oy: number): PanResponderGestureState {
  if (!ox && !oy) return g;
  const hasStart = g.x0 !== 0 || g.y0 !== 0;
  const hasMove = g.moveX !== 0 || g.moveY !== 0;
  return {
    ...g,
    x0: hasStart ? g.x0 - ox : g.x0,
    y0: hasStart ? g.y0 - oy : g.y0,
    moveX: hasMove ? g.moveX - ox : g.moveX,
    moveY: hasMove ? g.moveY - oy : g.moveY,
  };
}

const PAN_CALLBACKS = [
  "onStartShouldSetPanResponder",
  "onStartShouldSetPanResponderCapture",
  "onMoveShouldSetPanResponder",
  "onMoveShouldSetPanResponderCapture",
  "onPanResponderGrant",
  "onPanResponderReject",
  "onPanResponderStart",
  "onPanResponderMove",
  "onPanResponderEnd",
  "onPanResponderRelease",
  "onPanResponderTerminate",
  "onPanResponderTerminationRequest",
] as const;

export const PanResponder = {
  ...WebPanResponder,
  create(config: PanResponderCallbacks) {
    const wrapped: Record<string, unknown> = { ...config };
    for (const key of PAN_CALLBACKS) {
      const fn = config[key] as ((e: GestureResponderEvent, g: PanResponderGestureState) => unknown) | undefined;
      if (!fn) continue;
      wrapped[key] = (e: GestureResponderEvent, g: PanResponderGestureState) => {
        const [ox, oy] = windowOffset(e as unknown as { currentTarget?: unknown; target?: unknown });
        return fn(windowEvent(e, ox, oy), windowGesture(g, ox, oy));
      };
    }
    return WebPanResponder.create(wrapped as PanResponderCallbacks);
  },
} as typeof WebPanResponder;

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

export const findNodeHandle = (component: unknown) => (component instanceof Element ? component : null) as unknown as number | null;

type KeyMatch = { key: string; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean };
type MacTextInputProps = ComponentProps<typeof WebTextInput> & {
  keyDownEvents?: KeyMatch[];
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
};

const MODIFIERS = ["metaKey", "shiftKey", "altKey", "ctrlKey"] as const;
const matches = (e: KeyboardEvent, wanted: KeyMatch) =>
  e.key === wanted.key && MODIFIERS.every((m) => wanted[m] === undefined || !!e[m] === wanted[m]);

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export const NATIVE_CHANGE = Symbol("ardiaNativeChange");

export const TextInput = forwardRef<unknown, MacTextInputProps>(function MacTextInput({ keyDownEvents, onKeyDown, ...props }, ref) {
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!keyDownEvents) return onKeyDown?.(e);
    if (!keyDownEvents.some((wanted) => matches(e, wanted))) return;
    e.preventDefault();
    onKeyDown?.(e);
  };
  const native = useRef({ changeText: props.onChangeText, selectionChange: props.onSelectionChange });
  native.current = { changeText: props.onChangeText, selectionChange: props.onSelectionChange };
  const attach = useCallback((node: HTMLInputElement | null) => {
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
  return <Input {...props} ref={attach} onChange={onChange} onKeyPress={onKeyDown || keyDownEvents ? handleKeyDown : props.onKeyPress} />;
});
