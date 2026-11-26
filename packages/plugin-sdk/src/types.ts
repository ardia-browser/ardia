import type { Component } from "./element";
import type { CallKind, OmniboxSuggestion, SurfaceKind } from "./protocol";

export type Awaitable<T> = T | Promise<T>;

export type Disposable = { dispose(): void };

export type CancelSignal = { readonly cancelled: boolean; onCancel(listener: () => void): Disposable };

export type CallContext = {
  readonly callId: string;
  readonly kind: CallKind;
  readonly name: string;
  readonly context: Record<string, unknown>;
  readonly caller: unknown;
  readonly deadline: number | undefined;
  readonly signal: CancelSignal;
};

export type ToolHandler<I = any, O = unknown> = (input: I, call: CallContext) => Awaitable<O>;

export type CommandHandler<I = any> = (input: I, call: CallContext) => Awaitable<unknown>;

export type OmniboxProvider = (query: string, call: CallContext) => Awaitable<readonly OmniboxSuggestion[] | null | undefined>;

export type DecideHandler<D = Record<string, unknown>, R = unknown> = (data: D, call: CallContext) => Awaitable<R>;

export type EventListener<D = Record<string, unknown>> = (data: D, event: { name: string; time: number | undefined }) => void;

export type StateListener<D = Record<string, unknown>> = (data: D, event: { name: string; time: number | undefined }) => void;

export type PageMessageListener = (message: unknown, view: string) => void;

export type SettingsListener = (values: Readonly<Record<string, unknown>>) => void;

export type ViewProps<C extends Record<string, unknown> = Record<string, unknown>> = {
  surfaceId: string;
  viewId: string;
  kind: SurfaceKind;
  context: C;
};

export type ViewComponent = Component<ViewProps<any>>;

export type PluginDefinition<A = unknown> = {
  activate?: (ardia: A) => Awaitable<void | Disposable>;
  deactivate?: () => Awaitable<void>;
  commands?: Record<string, CommandHandler>;
  tools?: Record<string, ToolHandler>;
  views?: Record<string, ViewComponent>;
  omnibox?: OmniboxProvider;
  decide?: Record<string, DecideHandler<any>>;
  events?: Record<string, EventListener<any>>;
  onPageMessage?: PageMessageListener;
  onSettingsChange?: SettingsListener;
};

export type Registry = {
  commands: Map<string, CommandHandler>;
  tools: Map<string, ToolHandler>;
  views: Map<string, ViewComponent>;
  omnibox: Set<OmniboxProvider>;
  decide: Map<string, DecideHandler<any>>;
  events: Map<string, Set<EventListener<any>>>;
  state: Map<string, Set<StateListener<any>>>;
  pages: Set<PageMessageListener>;
  settings: Set<SettingsListener>;
};

export function createRegistry(): Registry {
  return {
    commands: new Map(),
    tools: new Map(),
    views: new Map(),
    omnibox: new Set(),
    decide: new Map(),
    events: new Map(),
    state: new Map(),
    pages: new Set(),
    settings: new Set(),
  };
}

export function disposable(dispose: () => void): Disposable {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      dispose();
    },
  };
}

export function registerIn<K, V>(map: Map<K, V>, key: K, value: V, label: string): Disposable {
  if (map.has(key)) throw new Error(`${label} ${String(key)} is already registered.`);
  map.set(key, value);
  return disposable(() => {
    if (map.get(key) === value) map.delete(key);
  });
}

export function addTo<V>(set: Set<V>, value: V): Disposable {
  set.add(value);
  return disposable(() => set.delete(value));
}
