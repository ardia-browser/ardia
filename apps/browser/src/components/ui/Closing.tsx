import { createContext, use, useCallback, useEffect, useLayoutEffect, useRef, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";
import { Animated, type TextInput } from "react-native";

const ClosingContext = createContext(false);

export const useClosing = () => use(ClosingContext);

export function ClosingScope({ closing, children }: { closing: boolean; children: ReactNode }) {
  const outer = useClosing();
  return <ClosingContext value={closing || outer}>{children}</ClosingContext>;
}

export function ClosingView({ closing, pointerEvents, children, ...props }: Omit<ComponentPropsWithRef<typeof Animated.View>, "children"> & { closing: boolean; children?: ReactNode }) {
  const outer = useClosing();
  const dead = closing || outer;
  const cutoff = {
    pointerEvents: dead ? ("none" as const) : pointerEvents,
    accessibilityElementsHidden: dead,
    importantForAccessibility: dead ? ("no-hide-descendants" as const) : ("auto" as const),
    inert: dead || undefined,
  };
  return (
    <Animated.View {...props} {...cutoff}>
      <ClosingContext value={dead}>{children}</ClosingContext>
    </Animated.View>
  );
}

export type Live = <H>(handler: H) => H | undefined;

type Action = (...args: never[]) => unknown;
type Latest = { current: boolean };

const DROPPED: Live = () => undefined;

export function guardedLive(latest: Latest, guards: WeakMap<Action, Action>): Live {
  return <H,>(handler: H): H | undefined => {
    if (typeof handler !== "function") return handler;
    const action = handler as unknown as Action;
    let guard = guards.get(action);
    if (!guard) {
      guard = ((...args: never[]) => (latest.current ? undefined : action(...args))) as Action;
      guards.set(action, guard);
    }
    return guard as unknown as H;
  };
}

export function useLiveWhile(closing: boolean): Live {
  const latest = useRef(closing);
  useLayoutEffect(() => {
    latest.current = closing;
  }, [closing]);
  const kept = useRef<Live | null>(null);
  kept.current ??= guardedLive(latest, new WeakMap());
  return closing ? DROPPED : kept.current;
}

export const useLiveAction = () => useLiveWhile(useClosing());

const IGNORED = () => {};
const ALWAYS_OPEN = () => true;

export const whileOpen =
  (closing: boolean, stillOpen: () => boolean = ALWAYS_OPEN) =>
  <A extends unknown[]>(action: (...args: A) => unknown): ((...args: A) => void) =>
    closing
      ? IGNORED
      : (...args: A) => {
          if (stillOpen()) action(...args);
        };

export function useStillOpen(open: boolean) {
  const latest = useRef(open);
  useLayoutEffect(() => {
    latest.current = open;
  }, [open]);
  return useCallback(() => latest.current, []);
}

export function useClosingField(inputRef?: Ref<TextInput>) {
  const closing = useClosing();
  const field = useRef<TextInput | null>(null);
  useEffect(() => {
    if (closing) field.current?.blur();
  }, [closing]);
  const ref = useCallback(
    (node: TextInput | null) => {
      field.current = node;
      if (typeof inputRef === "function") inputRef(node);
      else if (inputRef) inputRef.current = node;
    },
    [inputRef],
  );
  return { closing, ref };
}
