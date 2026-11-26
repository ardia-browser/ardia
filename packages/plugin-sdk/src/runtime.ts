import { createArdia, type ApiState, type Ardia } from "./api";
import { enqueueMicrotask } from "./reconciler";
import {
  HOST_METHODS as M,
  PLUGIN_PROTOCOL,
  isSurfaceMessage,
  type CallKind,
  type HelloResult,
  type OmniboxSuggestion,
  type PluginCallMessage,
  type ReadyParams,
} from "./protocol";
import { PluginError, createRpc, errorMessage, isUnencodable, type Transport } from "./rpc";
import { createSurfaceHost } from "./surfaces";
import { createSubscriptionSync, STATE_PREFIX, type ResyncOptions } from "./subscriptions";
import { createRegistry, disposable, type CallContext, type CancelSignal, type Disposable, type PluginDefinition, type Registry } from "./types";

export const SDK_VERSION = "2.0.0";

export type HostRuntimeOptions = { onError?: (error: unknown) => void; stopGraceMs?: number } & ResyncOptions;

const DEFAULT_STOP_GRACE_MS = 5000;

type HostTimers = { setTimeout?: (callback: () => void, ms: number) => unknown; clearTimeout?: (timer: unknown) => void };

export type HostRuntime = {
  readonly ardia: Ardia;
  readonly registry: Registry;
  definePlugin(definition: PluginDefinition<Ardia>): Promise<void>;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  surfaceCount(): number;
  callCount(): number;
  surfaceTree(surfaceId: string): unknown;
  whenIdle(): Promise<void>;
  dispose(): Promise<void>;
};

type Signal = CancelSignal & { cancel(): void };

function createSignal(): Signal {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    onCancel(listener) {
      if (cancelled) listener();
      else listeners.add(listener);
      return disposable(() => listeners.delete(listener));
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const listener of listeners) listener();
      listeners.clear();
    },
  };
}

function cleanSuggestion(value: unknown): OmniboxSuggestion | null {
  if (typeof value !== "object" || value === null) return null;
  const { title, url, subtitle, icon, badge } = value as Record<string, unknown>;
  if (typeof title !== "string" || typeof url !== "string") return null;
  const out: OmniboxSuggestion = { title, url };
  if (typeof subtitle === "string") out.subtitle = subtitle;
  if (typeof icon === "string") out.icon = icon;
  if (typeof badge === "string") out.badge = badge;
  return out;
}

function queryOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null) {
    const { query, text } = input as { query?: unknown; text?: unknown };
    if (typeof query === "string") return query;
    if (typeof text === "string") return text;
  }
  return "";
}

const CALL_KINDS: readonly CallKind[] = ["tool", "command", "omnibox", "decide"];

function inputOf(kind: CallKind, message: PluginCallMessage): unknown {
  if (message.input !== undefined) return message.input;
  if (kind === "decide") return message.data;
  if (kind === "omnibox") return message.query;
  return undefined;
}

export function createHostRuntime(transport: Transport, options: HostRuntimeOptions = {}): HostRuntime {
  const rpc = createRpc(transport);
  const registry = createRegistry();
  const calls = new Map<string, Signal>();
  const report = (error: unknown) => {
    if (options.onError) options.onError(error);
    else (globalThis as { console?: { error?: (...a: unknown[]) => void } }).console?.error?.("[ardia plugin]", error);
  };
  let activation: Promise<void> = Promise.resolve();
  let activated = false;
  let stopped = false;
  let stopping: Promise<void> | null = null;
  let work = Promise.resolve();
  let cleanup: () => Promise<void> = async () => surfaces.closeAll();

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    let begin!: () => void;
    stopping = new Promise<void>((resolve) => (begin = resolve)).then(() => cleanup());
    const running = [...calls.values()];
    calls.clear();
    for (const signal of running) {
      try {
        signal.cancel();
      } catch (error) {
        report(error);
      }
    }
    begin();
    return stopping;
  };

  const stopWithinGrace = async () => {
    const { setTimeout: startTimer, clearTimeout: cancelTimer } = globalThis as HostTimers;
    if (!startTimer || !cancelTimer) return stop();
    let timer: unknown;
    const graceOver = new Promise<void>((resolve) => (timer = startTimer(resolve, options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS)));
    try {
      await Promise.race([stop(), graceOver]);
    } finally {
      cancelTimer(timer);
    }
  };

  const subscriptions = createSubscriptionSync(rpc, registry, report, () => activated && !stopped, options);

  const state: ApiState = {
    values: {},
    info: { name: "", app: "", version: "", protocol: 0 },
    subscriptionsChanged: () => subscriptions.sync(),
    listenerAdded: (topic) => subscriptions.listenerAdded(topic),
    report,
  };
  const ardia = createArdia(rpc, registry, state);
  const surfaces = createSurfaceHost(rpc, registry, report);

  const whenActive = (task: () => unknown, refuse?: (activationError: unknown) => unknown) => {
    work = work
      .then(() => activation)
      .then(
        () => (stopped ? undefined : task()),
        (activationError) => (stopped ? undefined : refuse?.(activationError)),
      )
      .then(
        () => undefined,
        (error) => report(error),
      );
  };

  async function dispatchCall(kind: CallKind, name: string, input: unknown, call: CallContext): Promise<unknown> {
    if (kind === "tool") {
      const tool = registry.tools.get(name);
      if (!tool) throw new Error(`This plugin has no tool ${name}.`);
      return tool(input, call);
    }
    if (kind === "command") {
      const command = registry.commands.get(name);
      if (!command) throw new Error(`This plugin has no command ${name}.`);
      return command(input, call);
    }
    if (kind === "decide") {
      const decide = registry.decide.get(name);
      if (!decide) throw new Error(`This plugin doesn't decide ${name}.`);
      return decide((input ?? {}) as Record<string, unknown>, call);
    }
    const query = queryOf(input);
    const lists = await Promise.all([...registry.omnibox].map(async (provider) => (await provider(query, call)) ?? []));
    return lists.flat().map(cleanSuggestion).filter((s): s is OmniboxSuggestion => s !== null);
  }

  const forgetCall = (callId: string, signal: Signal) => {
    if (calls.get(callId) === signal) calls.delete(callId);
  };

  async function answer(message: PluginCallMessage, signal: Signal) {
    if (signal.cancelled) return forgetCall(message.call, signal);
    const kind: CallKind = message.kind && CALL_KINDS.includes(message.kind) ? message.kind : "tool";
    const name = message.name ?? message.tool ?? message.command ?? message.event ?? message.provider ?? "";
    const call: CallContext = {
      callId: message.call,
      kind,
      name,
      context: message.context ?? {},
      caller: message.caller ?? null,
      deadline: typeof message.deadline === "number" ? message.deadline : undefined,
      signal,
    };
    let body: Record<string, unknown>;
    try {
      const result = await dispatchCall(kind, name, inputOf(kind, message), call);
      body = { call: message.call, result: result === undefined ? null : result };
    } catch (error) {
      body = { call: message.call, error: errorMessage(error) };
    } finally {
      forgetCall(message.call, signal);
    }
    if (signal.cancelled) return;
    await sendResult(body);
  }

  async function sendResult(body: Record<string, unknown>) {
    try {
      await rpc.request(M.result, body);
    } catch (error) {
      if (!isUnencodable(error)) return report(error);
      await rpc.request(M.result, { call: body.call, error: `The plugin's result couldn't be sent: ${errorMessage(error)}` }).catch(report);
    }
  }

  async function refuseCall(message: PluginCallMessage, signal: Signal, activationError: unknown) {
    forgetCall(message.call, signal);
    if (signal.cancelled) return;
    await sendResult({ call: message.call, error: `The plugin didn't activate: ${errorMessage(activationError)}` });
  }

  function deliverEvent(name: string, data: Record<string, unknown>, time: number | undefined) {
    if (name.startsWith(STATE_PREFIX)) return subscriptions.deliverState(name, data, time);
    if (name === "plugin.values") {
      const values = (data.values ?? data) as Record<string, unknown>;
      state.values = { ...state.values, ...values };
      for (const listener of [...registry.settings]) listener({ ...state.values });
    }
    const targets = [...(registry.events.get(name) ?? []), ...(name === "plugin.values" ? [] : (registry.events.get("*") ?? []))];
    for (const listener of targets) {
      try {
        listener(data, { name, time });
      } catch (error) {
        report(error);
      }
    }
  }

  function handleLine(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return report(new Error(`The host sent a line that isn't JSON: ${line.slice(0, 120)}`));
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    if (rpc.takeReply(record) || stopped) return;
    if (isSurfaceMessage(record)) return whenActive(() => surfaces.handle(record));
    if (typeof record.call === "string") {
      if (record.cancel === true) return calls.get(record.call)?.cancel();
      const signal = createSignal();
      calls.set(record.call, signal);
      return whenActive(
        () => void answer(record as PluginCallMessage, signal),
        (activationError) => void refuseCall(record as PluginCallMessage, signal, activationError),
      );
    }
    if ("pageMessage" in record) {
      const view = typeof record.view === "string" ? record.view : "";
      return whenActive(() => {
        for (const listener of [...registry.pages]) listener(record.pageMessage, view);
      });
    }
    if (typeof record.event === "string") {
      subscriptions.noteDropped(record.dropped);
      const data = (typeof record.data === "object" && record.data !== null ? record.data : {}) as Record<string, unknown>;
      const time = typeof record.time === "number" ? record.time : undefined;
      if (record.event === "plugin.values") return deliverEvent(record.event, data, time);
      if (record.event === "plugin.stopping") return void stop().catch(report);
      return whenActive(() => deliverEvent(record.event as string, data, time));
    }
  }

  transport.onLine((line) => {
    try {
      handleLine(line);
    } catch (error) {
      report(error);
    }
  });

  function register(definition: PluginDefinition<Ardia>): Disposable[] {
    const held: Disposable[] = [];
    for (const [name, handler] of Object.entries(definition.commands ?? {})) held.push(ardia.commands.register(name, handler));
    for (const [name, handler] of Object.entries(definition.tools ?? {})) held.push(ardia.tools.register(name, handler));
    for (const [id, view] of Object.entries(definition.views ?? {})) held.push(ardia.views.register(id, view));
    for (const [name, handler] of Object.entries(definition.decide ?? {})) held.push(ardia.hooks.decide(name, handler));
    for (const [name, listener] of Object.entries(definition.events ?? {})) held.push(ardia.hooks.on(name, listener));
    if (definition.omnibox) held.push(ardia.omnibox.register(definition.omnibox));
    if (definition.onPageMessage) held.push(ardia.pages.onMessage(definition.onPageMessage));
    if (definition.onSettingsChange) held.push(ardia.settings.onChange(definition.onSettingsChange));
    return held;
  }

  const readyParams = (): ReadyParams => ({
    commands: [...registry.commands.keys()],
    tools: [...registry.tools.keys()],
    views: [...registry.views.keys()],
    omnibox: registry.omnibox.size > 0,
    decide: [...registry.decide.keys()],
    events: [...registry.events.keys()],
  });

  function definePlugin(definition: PluginDefinition<Ardia>): Promise<void> {
    const held = register(definition);
    cleanup = async () => {
      surfaces.closeAll();
      for (const item of held.splice(0).reverse()) {
        try {
          item.dispose();
        } catch (error) {
          report(error);
        }
      }
      if (definition.deactivate) await definition.deactivate();
    };
    activation = (async () => {
      const hello = (await rpc.request<HelloResult>(M.hello, { protocol: PLUGIN_PROTOCOL, sdk: SDK_VERSION }).catch((error) => {
        report(error);
        return null;
      })) ?? { app: "", version: "", protocol: 0, plugin: "" };
      if (stopped) return;
      state.info = { name: hello.plugin, app: hello.app, version: hello.version, protocol: hello.protocol };
      state.values = { ...(hello.values ?? {}), ...state.values };
      const returned = definition.activate ? await definition.activate(ardia) : undefined;
      if (returned && typeof returned.dispose === "function") {
        if (stopped) returned.dispose();
        else held.push(returned);
      }
      if (stopped) return;
      activated = true;
      subscriptions.sync();
    })();
    const ready = activation.then(() => (stopped ? undefined : rpc.request(M.ready, readyParams()))).then(() => undefined);
    ready.catch(report);
    return ready;
  }

  return {
    ardia,
    registry,
    definePlugin,
    request: (method, params) => rpc.request(method, params),
    surfaceCount: () => surfaces.count(),
    callCount: () => calls.size,
    surfaceTree: (surfaceId) => surfaces.tree(surfaceId),
    whenIdle: async () => {
      for (let i = 0; i < 20; i++) {
        const pending = work;
        await pending;
        await new Promise<void>((resolve) => enqueueMicrotask(resolve));
        if (pending === work) return;
      }
    },
    dispose: async () => {
      try {
        await stopWithinGrace();
      } finally {
        rpc.close(new PluginError("stopped", "The plugin stopped."));
      }
    },
  };
}
