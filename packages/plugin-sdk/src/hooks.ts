import type { Context } from "./element";
import { depsChanged, type Deps, type EffectCallback, type EffectHook, type Fiber, type Hook, type MemoHook, type RefHook, type StateHook } from "./fiber";

let current: Fiber | null = null;
let cursor = 0;

export function beginHooks(fiber: Fiber): void {
  current = fiber;
  cursor = 0;
}

export function endHooks(): void {
  current = null;
  cursor = 0;
}

function claimHook<H extends Hook>(kind: H["kind"], make: (fiber: Fiber) => H): [H, Fiber] {
  const fiber = current;
  if (!fiber) throw new Error("Hooks only work inside a component while it renders.");
  const at = cursor++;
  const existing = fiber.hooks[at];
  if (existing) {
    if (existing.kind !== kind) throw new Error(`Hook ${at} changed from ${existing.kind} to ${kind}; call hooks in the same order on every render.`);
    return [existing as H, fiber];
  }
  const made = make(fiber);
  fiber.hooks[at] = made;
  return [made, fiber];
}

export type SetStateAction<S> = S | ((previous: S) => S);
export type Dispatch<A> = (action: A) => void;
export type MutableRefObject<T> = { current: T };
export type RefObject<T> = { readonly current: T | null };

function stateHook(fiber: Fiber, initial: unknown, reduce: (previous: unknown, action: unknown) => unknown): StateHook {
  const hook: StateHook = {
    kind: "state",
    value: initial,
    set: (action) => {
      if (!fiber.alive) return;
      const next = reduce(hook.value, action);
      if (Object.is(next, hook.value)) return;
      hook.value = next;
      fiber.scheduler.schedule();
    },
  };
  return hook;
}

const applyAction = (previous: unknown, action: unknown) => (typeof action === "function" ? (action as (value: unknown) => unknown)(previous) : action);

export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
export function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
export function useState<S>(initial?: S | (() => S)): [S, Dispatch<SetStateAction<S>>] {
  const [hook] = claimHook<StateHook>("state", (fiber) => stateHook(fiber, typeof initial === "function" ? (initial as () => S)() : initial, applyAction));
  return [hook.value as S, hook.set as Dispatch<SetStateAction<S>>];
}

export function useReducer<S, A>(reducer: (state: S, action: A) => S, initialArg: S): [S, Dispatch<A>];
export function useReducer<S, A, I>(reducer: (state: S, action: A) => S, initialArg: I, init: (arg: I) => S): [S, Dispatch<A>];
export function useReducer<S, A, I>(reducer: (state: S, action: A) => S, initialArg: I, init?: (arg: I) => S): [S, Dispatch<A>] {
  const latest = useRef(reducer);
  latest.current = reducer;
  const [hook] = claimHook<StateHook>("state", (fiber) =>
    stateHook(fiber, init ? init(initialArg) : initialArg, (previous, action) => latest.current(previous as S, action as A)),
  );
  return [hook.value as S, hook.set as Dispatch<A>];
}

export function useEffect(effect: EffectCallback, deps?: Deps): void {
  const [hook, fiber] = claimHook<EffectHook>("effect", () => ({ kind: "effect", deps: undefined, cleanup: undefined, next: undefined }));
  if (hook.deps !== undefined && !depsChanged(hook.deps, deps)) return;
  hook.deps = deps;
  hook.next = effect;
  fiber.scheduler.queueEffect(fiber, hook);
}

export const useLayoutEffect = useEffect;

export function useMemo<T>(factory: () => T, deps: Deps): T {
  const [hook] = claimHook<MemoHook>("memo", () => ({ kind: "memo", deps: undefined, value: undefined, ready: false }));
  if (!hook.ready || depsChanged(hook.deps, deps)) {
    hook.value = factory();
    hook.deps = deps;
    hook.ready = true;
  }
  return hook.value as T;
}

export function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: Deps): T {
  return useMemo(() => callback, deps);
}

export function useRef<T>(initial: T): MutableRefObject<T>;
export function useRef<T>(initial: T | null): RefObject<T>;
export function useRef<T = undefined>(): MutableRefObject<T | undefined>;
export function useRef<T>(initial?: T): MutableRefObject<T | undefined> {
  const [hook] = claimHook<RefHook>("ref", () => ({ kind: "ref", value: { current: initial } }));
  return hook.value as MutableRefObject<T | undefined>;
}

export function useContext<T>(context: Context<T>): T {
  const fiber = current;
  if (!fiber) throw new Error("useContext only works inside a component while it renders.");
  return fiber.context.has(context.id) ? (fiber.context.get(context.id) as T) : context.defaultValue;
}

export function useId(): string {
  const slot = cursor;
  return useMemo(() => {
    const seed = `${current!.path}#${slot}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (Math.imul(hash, 31) + seed.charCodeAt(i)) | 0;
    return `ardia-${(hash >>> 0).toString(36)}-${slot.toString(36)}`;
  }, []);
}

export function useForceUpdate(): () => void {
  const [, set] = useState(0);
  return useCallback(() => set((n) => n + 1), []);
}
