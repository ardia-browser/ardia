import { consumerOf, hostTypeOf, isVNode, jsx, providerOf, type Component, type Key, type Renderable, type VNode } from "./element";
import { newFiber, unmountFiber, type ContextValues, type Deps, type EffectHook, type Fiber, type SurfaceScheduler } from "./fiber";
import { beginHooks, endHooks } from "./hooks";
import type { PluginNode, PluginNodeType, SerializedHandler } from "./protocol";

type Rendered = PluginNode | string;
type AnyHandler = (...args: unknown[]) => unknown;

export type HandlerTable = ReadonlyMap<string, AnyHandler>;
type CreatedFiber = { parent: Fiber; slot: string; fiber: Fiber };
type RenderedFiber = { fiber: Fiber; hookCount: number; effectDeps: [EffectHook, Deps][] };

export type SurfaceOptions = { onError?: (error: unknown) => void; maxRenders?: number };

export type SurfaceHandle<P> = {
  readonly tree: PluginNode | null;
  update(props: P): void;
  dispatch(handlerId: string, args?: readonly unknown[]): unknown;
  hasHandler(handlerId: string): boolean;
  flush(): void;
  unmount(): void;
};

const nativeMicrotask = (globalThis as { queueMicrotask?: (task: () => void) => void }).queueMicrotask;

export const enqueueMicrotask: (task: () => void) => void =
  typeof nativeMicrotask === "function" ? (task) => nativeMicrotask(task) : (task) => void Promise.resolve().then(task);

const EMPTY_CONTEXT: ContextValues = new Map();

const fiberKeys = new WeakMap<Fiber, Key>();

const fiberSerials = new WeakMap<Fiber, number>();

let lastFiberSerial = 0;

let lastSurfaceSerial = 0;

function serialOf(fiber: Fiber): number {
  let serial = fiberSerials.get(fiber);
  if (serial === undefined) fiberSerials.set(fiber, (serial = ++lastFiberSerial));
  return serial;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> => typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

function describe(value: unknown): string {
  if (typeof value === "function") return `a function (${(value as { name?: string }).name || "anonymous"})`;
  if (typeof value === "symbol") return "a symbol";
  if (typeof value === "object" && value !== null) return `an object with keys ${Object.keys(value).join(", ") || "none"}`;
  return typeof value;
}

export function errorNode(error: unknown): PluginNode {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: "EmptyState",
    props: { icon: "exclamationmark.triangle", title: "This view hit an error", description: message, tone: "destructive" },
    children: [],
  };
}

export function asTree(nodes: Rendered[]): PluginNode {
  if (nodes.length === 1 && typeof nodes[0] === "object") return nodes[0];
  return { type: "Fragment", props: {}, children: nodes };
}

class Surface<P> implements SurfaceScheduler, SurfaceHandle<P> {
  tree: PluginNode | null = null;
  private readonly root: Fiber;
  private handlers = new Map<string, AnyHandler>();
  private readonly handlerIds = new Map<string, string>();
  private passHandlers = new Map<string, AnyHandler>();
  private passPaths = new Set<string>();
  private nextHandler = 0;
  private readonly handlerPrefix = `h${++lastSurfaceSerial}.`;
  private effects: { fiber: Fiber; hook: EffectHook }[] = [];
  private passCreated: CreatedFiber[] = [];
  private passRemoved: CreatedFiber[] = [];
  private passRendered: RenderedFiber[] = [];
  private scheduled = false;
  private rendering = false;
  private dead = false;
  private chained = 0;
  private cycling = false;
  private exhausted = false;
  private readonly element: Component<P> | VNode;
  private props: P;
  private readonly onCommit: (tree: PluginNode, handlers: HandlerTable) => void;
  private readonly options: SurfaceOptions;

  constructor(element: Component<P> | VNode, props: P, onCommit: (tree: PluginNode, handlers: HandlerTable) => void, options: SurfaceOptions) {
    this.element = element;
    this.props = props;
    this.onCommit = onCommit;
    this.options = options;
    this.root = newFiber("root", "", this);
  }

  schedule(): void {
    if (this.dead || this.exhausted) return;
    if (!this.cycling) this.chained = 0;
    if (this.scheduled) return;
    this.scheduled = true;
    enqueueMicrotask(() => {
      if (!this.scheduled) return;
      this.scheduled = false;
      this.render();
    });
  }

  queueEffect(fiber: Fiber, hook: EffectHook): void {
    this.effects.push({ fiber, hook });
  }

  report(error: unknown): void {
    if (this.options.onError) this.options.onError(error);
    else (globalThis as { console?: { error?: (...a: unknown[]) => void } }).console?.error?.(error);
  }

  update(props: P): void {
    this.props = props;
    this.schedule();
  }

  flush(): void {
    if (!this.scheduled || this.rendering) return;
    this.scheduled = false;
    this.render();
  }

  hasHandler(handlerId: string): boolean {
    return this.handlers.has(handlerId);
  }

  dispatch(handlerId: string, args: readonly unknown[] = []): unknown {
    if (this.dead) throw new Error("This view is closed.");
    const handler = this.handlers.get(handlerId);
    if (!handler) throw new Error(`There's no handler ${handlerId}; the view re-rendered without it.`);
    return handler(...args);
  }

  unmount(): void {
    if (this.dead) return;
    this.dead = true;
    this.scheduled = false;
    this.effects = [];
    unmountFiber(this.root);
    this.handlers.clear();
    this.handlerIds.clear();
  }

  render(): void {
    if (this.dead) return;
    if (this.rendering) return this.schedule();
    const limit = this.options.maxRenders ?? 50;
    this.rendering = true;
    this.cycling = true;
    this.chained++;
    this.exhausted = this.chained > limit;
    try {
      const tree = this.renderPass(limit);
      if (this.dead) return;
      this.tree = tree;
      try {
        this.onCommit(tree, this.handlers);
      } catch (error) {
        this.report(error);
      }
      this.runEffects();
    } finally {
      this.exhausted = false;
      this.rendering = false;
      this.cycling = false;
    }
  }

  private renderPass(limit: number): PluginNode {
    this.passHandlers = new Map();
    this.passPaths = new Set();
    this.passCreated = [];
    this.passRemoved = [];
    this.passRendered = [];
    try {
      if (this.exhausted) throw new Error(`The view re-rendered ${limit} times in a row; a state update is looping.`);
      const top = typeof this.element === "function" ? jsx(this.element as Component<never>, this.props as Record<string, unknown>) : this.element;
      this.root.seen.clear();
      const nodes = this.renderValue(this.root, "r", top, EMPTY_CONTEXT, null);
      this.sweep(this.root);
      const removed = this.passRemoved;
      this.passRemoved = [];
      for (const { fiber } of removed) unmountFiber(fiber);
      if (this.dead) return errorNode(new Error("This view is closed."));
      this.handlers = this.passHandlers;
      for (const path of [...this.handlerIds.keys()]) if (!this.passPaths.has(path)) this.handlerIds.delete(path);
      return asTree(nodes);
    } catch (error) {
      endHooks();
      this.abandonPass();
      this.handlers = new Map();
      this.report(error);
      return errorNode(error);
    } finally {
      this.passCreated = [];
      this.passRemoved = [];
      this.passRendered = [];
    }
  }

  private abandonPass(): void {
    for (const { hook } of this.effects) hook.next = undefined;
    this.effects = [];
    for (const { fiber, hookCount, effectDeps } of this.passRendered) {
      fiber.hooks.length = Math.min(fiber.hooks.length, hookCount);
      for (const [hook, deps] of effectDeps) {
        hook.deps = deps;
        hook.next = undefined;
      }
    }
    for (const { parent, slot, fiber } of this.passCreated.reverse()) {
      if (parent.children.get(slot) === fiber) parent.children.delete(slot);
      unmountFiber(fiber);
    }
    for (const { parent, slot, fiber } of this.passRemoved.reverse()) {
      if (this.dead) unmountFiber(fiber);
      else parent.children.set(slot, fiber);
    }
  }

  private runEffects(): void {
    const queued = this.effects;
    this.effects = [];
    for (const { fiber, hook } of queued) {
      if (!fiber.alive || !hook.cleanup) continue;
      const cleanup = hook.cleanup;
      hook.cleanup = undefined;
      try {
        cleanup();
      } catch (error) {
        this.report(error);
      }
    }
    for (const { fiber, hook } of queued) {
      const effect = hook.next;
      hook.next = undefined;
      if (!fiber.alive || !effect) continue;
      try {
        const result = effect();
        if (isThenable(result)) result.then(undefined, (error: unknown) => this.report(error));
        const cleanup = typeof result === "function" ? (result as () => void) : undefined;
        if (fiber.alive) hook.cleanup = cleanup;
        else cleanup?.();
      } catch (error) {
        this.report(error);
      }
    }
  }

  private claim(parent: Fiber, slot: string, type: unknown, key: Key | null): Fiber {
    let fiber = parent.children.get(slot);
    if (fiber && (fiber.type !== type || (fiberKeys.get(fiber) ?? null) !== key)) {
      this.passRemoved.push({ parent, slot, fiber });
      fiber = undefined;
    }
    if (!fiber) {
      fiber = newFiber(type, `${parent.path}/${slot}`, this);
      if (key !== null) fiberKeys.set(fiber, key);
      parent.children.set(slot, fiber);
      this.passCreated.push({ parent, slot, fiber });
    }
    parent.seen.add(slot);
    return fiber;
  }

  private sweep(fiber: Fiber): void {
    for (const [slot, child] of fiber.children) {
      if (fiber.seen.has(slot)) continue;
      this.passRemoved.push({ parent: fiber, slot, fiber: child });
      fiber.children.delete(slot);
    }
  }

  private renderValue(parent: Fiber, slot: string, value: unknown, context: ContextValues, inheritedKey: Key | null): Rendered[] {
    if (value === null || value === undefined || typeof value === "boolean") return [];
    if (typeof value === "string") return [value];
    if (typeof value === "number" || typeof value === "bigint") return [String(value)];
    if (Array.isArray(value)) return this.renderList(parent, slot, value, context);
    if (!isVNode(value)) throw new TypeError(`A component returned ${describe(value)}; return an element, text, a list or null.`);
    const fiber = this.claim(parent, slot, value.type, value.key ?? null);
    const key = value.key ?? inheritedKey;
    const hostType = hostTypeOf(value.type);
    fiber.seen.clear();
    const rendered = hostType ? [this.renderHost(fiber, hostType, value.props, key, context)] : this.renderComponent(fiber, value, key, context);
    this.sweep(fiber);
    return rendered;
  }

  private renderList(parent: Fiber, slot: string, items: readonly unknown[], context: ContextValues): Rendered[] {
    const out: Rendered[] = [];
    items.forEach((item, index) => {
      let itemSlot = isVNode(item) && item.key !== null ? `${slot}:k${typeof item.key === "number" ? "n" : "s"}=${String(item.key)}` : `${slot}:i=${index}`;
      if (parent.seen.has(itemSlot)) itemSlot = `${itemSlot}~${index}`;
      for (const node of this.renderValue(parent, itemSlot, item, context, null)) out.push(node);
    });
    return out;
  }

  private renderComponent(fiber: Fiber, node: VNode, key: Key | null, context: ContextValues): Rendered[] {
    const provided = providerOf(node.type);
    if (provided) {
      const inner = new Map(context);
      inner.set(provided, node.props.value);
      return this.renderValue(fiber, "c", node.props.children, inner, key);
    }
    const consumed = consumerOf(node.type);
    if (consumed && context.has(consumed)) {
      const read = node.props.children as (value: unknown) => Renderable;
      return this.renderValue(fiber, "c", read(context.get(consumed)), context, key);
    }
    fiber.context = context;
    if (fiber.hooks.length > 0) {
      const effectDeps: [EffectHook, Deps][] = [];
      for (const hook of fiber.hooks) if (hook.kind === "effect") effectDeps.push([hook, hook.deps]);
      this.passRendered.push({ fiber, hookCount: fiber.hooks.length, effectDeps });
    }
    beginHooks(fiber);
    let result: Renderable;
    try {
      result = (node.type as (props: Record<string, unknown>) => Renderable)(node.props);
    } finally {
      endHooks();
    }
    return this.renderValue(fiber, "c", result, context, key);
  }

  private renderHost(fiber: Fiber, type: PluginNodeType, props: Record<string, unknown>, key: Key | null, context: ContextValues): PluginNode {
    const serialized: Record<string, unknown> = {};
    for (const name of Object.keys(props)) {
      if (name === "children") continue;
      const value = this.serialize(fiber, `p.${name}`, props[name], context);
      if (value !== undefined) serialized[name] = value;
    }
    const node: PluginNode = { type, props: serialized, children: this.renderValue(fiber, "c", props.children, context, null) };
    if (key !== null) node.key = key;
    return node;
  }

  private handlerRef(path: string, handler: AnyHandler): SerializedHandler {
    let id = this.handlerIds.get(path);
    if (!id) {
      id = `${this.handlerPrefix}${++this.nextHandler}`;
      this.handlerIds.set(path, id);
    }
    this.passHandlers.set(id, handler);
    this.passPaths.add(path);
    return { __handler: id };
  }

  private serialize(fiber: Fiber, path: string, value: unknown, context: ContextValues): unknown {
    if (value === undefined || typeof value === "symbol") return undefined;
    if (typeof value === "function") return this.handlerRef(`${serialOf(fiber)}|${path}`, value as AnyHandler);
    if (isVNode(value)) {
      const nodes = this.renderValue(fiber, path, value, context, null);
      if (nodes.length === 0) return null;
      return nodes.length === 1 ? nodes[0] : asTree(nodes);
    }
    if (Array.isArray(value)) return value.map((item, index) => this.serialize(fiber, `${path}[${index}]`, item, context) ?? null);
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "bigint") return String(value);
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const name of Object.keys(value)) {
        const item = this.serialize(fiber, `${path}.${name}`, value[name], context);
        if (item !== undefined) out[name] = item;
      }
      return out;
    }
    return value;
  }
}

export function mountSurface<P>(
  root: Component<P> | VNode,
  initialProps: P,
  onCommit: (tree: PluginNode, handlers: HandlerTable) => void,
  options: SurfaceOptions = {},
): SurfaceHandle<P> {
  const surface = new Surface(root, initialProps, onCommit, options);
  surface.render();
  return surface;
}
