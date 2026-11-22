export type ContextValues = ReadonlyMap<symbol, unknown>;

export type Cleanup = () => void;

export type EffectCallback = () => void | Cleanup | Promise<unknown>;

export type Deps = readonly unknown[] | undefined;

export type StateHook = { kind: "state"; value: unknown; set: (next: unknown) => void };

export type EffectHook = { kind: "effect"; deps: Deps; cleanup: Cleanup | undefined; next: EffectCallback | undefined };

export type MemoHook = { kind: "memo"; deps: Deps; value: unknown; ready: boolean };

export type RefHook = { kind: "ref"; value: { current: unknown } };

export type Hook = StateHook | EffectHook | MemoHook | RefHook;

export type SurfaceScheduler = {
  schedule(): void;
  queueEffect(fiber: Fiber, hook: EffectHook): void;
  report(error: unknown): void;
};

export type Fiber = {
  readonly type: unknown;
  readonly path: string;
  readonly scheduler: SurfaceScheduler;
  hooks: Hook[];
  children: Map<string, Fiber>;
  seen: Set<string>;
  context: ContextValues;
  alive: boolean;
};

export function newFiber(type: unknown, path: string, scheduler: SurfaceScheduler): Fiber {
  return { type, path, scheduler, hooks: [], children: new Map(), seen: new Set(), context: new Map(), alive: true };
}

export function depsChanged(previous: Deps, next: Deps): boolean {
  if (previous === undefined || next === undefined) return true;
  if (previous.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) if (!Object.is(previous[i], next[i])) return true;
  return false;
}

export function unmountFiber(fiber: Fiber): void {
  if (!fiber.alive) return;
  fiber.alive = false;
  for (const hook of fiber.hooks) {
    if (hook.kind !== "effect") continue;
    const cleanup = hook.cleanup;
    hook.cleanup = undefined;
    hook.next = undefined;
    if (!cleanup) continue;
    try {
      cleanup();
    } catch (error) {
      fiber.scheduler.report(error);
    }
  }
  for (const child of fiber.children.values()) unmountFiber(child);
  fiber.children.clear();
}
