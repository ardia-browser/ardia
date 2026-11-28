import type { Ardia } from "./api";
import { applyTreePatch, CHANNEL_EVENTS, type HelloResult, type PluginNode, type StateTopic, type SurfaceKind, type TreeOp } from "./protocol";
import { PluginError, type Transport } from "./rpc";
import { createHostRuntime, type HostRuntime, type HostRuntimeOptions } from "./runtime";
import type { PluginDefinition } from "./types";

export type MockRequest = { id: number; method: string; params: Record<string, unknown> };

export type MockHandler = (params: Record<string, unknown>, request: MockRequest) => unknown;

export type MockStream = { status?: number; statusText?: string; headers?: Record<string, string>; chunks?: readonly string[]; error?: string; url?: string };

export type MockFetch = { status?: number; statusText?: string; headers?: Record<string, string>; body?: string; url?: string };

export type UrlMatcher = string | RegExp | ((url: string) => boolean);

export type MockHostOptions = {
  plugin?: string;
  protocol?: number;
  values?: Record<string, unknown>;
  strict?: boolean;
  handlers?: Record<string, MockHandler>;
  runtime?: HostRuntimeOptions;
};

export type MockView = {
  readonly surfaceId: string;
  tree(): PluginNode | null;
  find(predicate: (node: PluginNode) => boolean): PluginNode | null;
  findAll(predicate: (node: PluginNode) => boolean): PluginNode[];
  byType(type: string): PluginNode[];
  text(): string;
  trigger(node: PluginNode, prop: string, ...args: unknown[]): Promise<void>;
  unmount(): Promise<void>;
};

export type MockHost = {
  readonly runtime: HostRuntime;
  readonly ardia: Ardia;
  readonly transport: Transport;
  readonly sent: MockRequest[];
  load(definition: PluginDefinition<Ardia>): Promise<void>;
  respond(method: string, handler: MockHandler): void;
  requests(method: string): Record<string, unknown>[];
  runCommand<T = unknown>(name: string, input?: unknown, context?: Record<string, unknown>): Promise<T>;
  callTool<T = unknown>(name: string, input?: unknown): Promise<T>;
  callService<T = unknown>(iface: string, method: string, input?: unknown): Promise<T>;
  decide<T = unknown>(name: string, data?: Record<string, unknown>): Promise<T>;
  omnibox(query: string): Promise<unknown[]>;
  cancel(callId: string): void;
  mountView(viewId: string, options?: { kind?: SurfaceKind; context?: Record<string, unknown> }): Promise<MockView>;
  emit(event: string, data?: Record<string, unknown>): Promise<void>;
  emitState(topic: StateTopic, data: Record<string, unknown>): Promise<void>;
  sendContentMessage(tabId: string, message: unknown, extra?: { frameId?: number; scriptId?: string }): Promise<void>;
  sendSidecarMessage(message: unknown): Promise<void>;
  mockFetch(match: UrlMatcher, response: MockFetch): void;
  mockFetchStream(match: UrlMatcher, response: MockStream): void;
  storage: Map<string, unknown>;
  secrets: Map<string, string>;
  settle(rounds?: number): Promise<void>;
  dispose(): Promise<void>;
};

type Timers = { setTimeout?: (callback: () => void, ms: number) => unknown };

const tick = () =>
  new Promise<void>((resolve) => {
    const timers = globalThis as Timers;
    if (timers.setTimeout) timers.setTimeout(resolve, 0);
    else void Promise.resolve().then(resolve);
  });

const matches = (matcher: UrlMatcher, url: string) => (typeof matcher === "string" ? url.startsWith(matcher) : matcher instanceof RegExp ? matcher.test(url) : matcher(url));

function walk(node: PluginNode | string, out: PluginNode[]) {
  if (typeof node === "string") return;
  out.push(node);
  for (const child of node.children) walk(child, out);
  for (const value of Object.values(node.props)) {
    if (value && typeof value === "object" && typeof (value as PluginNode).type === "string" && Array.isArray((value as PluginNode).children)) walk(value as PluginNode, out);
  }
}

function textOf(node: PluginNode | string): string {
  if (typeof node === "string") return node;
  const own = ["title", "subtitle", "text", "markdown", "code", "description", "label"].flatMap((key) => (typeof node.props[key] === "string" ? [node.props[key] as string] : []));
  return [...own, ...node.children.map(textOf)].filter(Boolean).join(" ");
}

export function createMockHost(options: MockHostOptions = {}): MockHost {
  const listeners: ((line: string) => void)[] = [];
  const sent: MockRequest[] = [];
  const handlers = new Map<string, MockHandler>(Object.entries(options.handlers ?? {}));
  const results = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  const trees = new Map<string, { tree: PluginNode | null; rev: number }>();
  const fetches: { match: UrlMatcher; response: MockFetch }[] = [];
  const streams: { match: UrlMatcher; response: MockStream }[] = [];
  const cancelled = new Set<string>();
  const storage = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  let nextCall = 0;
  let nextSurface = 0;

  const deliver = (message: Record<string, unknown>) => {
    const line = JSON.stringify(message);
    for (const listener of listeners) listener(line);
  };
  const event = (name: string, data: Record<string, unknown>) => deliver({ event: name, time: Date.now(), data });

  const defaults: Record<string, MockHandler> = {
    hello: (): HelloResult => ({ app: "Ardia", version: "0.0.0-test", protocol: options.protocol ?? 3, plugin: options.plugin ?? "@test/plugin", values: { ...(options.values ?? {}) } }),
    ready: () => ({ ok: true }),
    values: () => ({ ...(options.values ?? {}) }),
    subscribe: () => ({ ok: true }),
    "state.subscribe": () => ({ ok: true }),
    result: (params) => {
      const call = String(params.call);
      const waiter = results.get(call);
      results.delete(call);
      if (!waiter) return null;
      if (params.error !== undefined) waiter.reject(new PluginError("failed", String(params.error)));
      else waiter.resolve(params.result);
      return null;
    },
    "surface.render": (params) => {
      trees.set(String(params.surfaceId), { tree: params.tree as PluginNode, rev: typeof params.rev === "number" ? params.rev : 0 });
      return null;
    },
    "surface.patch": (params) => {
      const surfaceId = String(params.surfaceId);
      const current = trees.get(surfaceId);
      if (!current || current.rev !== params.base) throw new PluginError("stale", `surface.patch for ${surfaceId} is based on ${String(params.base)}, the host has ${current?.rev ?? "nothing"}`);
      trees.set(surfaceId, { tree: applyTreePatch(current.tree, params.ops as TreeOp[]), rev: Number(params.rev) });
      return null;
    },
    "storage.get": (params) => (storage.has(String(params.key)) ? { found: true, value: storage.get(String(params.key)) } : { found: false }),
    "storage.set": (params) => {
      storage.set(String(params.key), params.value);
      return null;
    },
    "storage.delete": (params) => {
      storage.delete(String(params.key));
      return null;
    },
    "storage.keys": () => ({ keys: [...storage.keys()] }),
    "secrets.get": (params) => ({ value: secrets.get(String(params.key)) ?? null }),
    "secrets.set": (params) => {
      secrets.set(String(params.key), String(params.value));
      return null;
    },
    "secrets.delete": (params) => {
      secrets.delete(String(params.key));
      return null;
    },
    "net.fetch": (params) => {
      const url = String(params.url);
      const mock = fetches.find((f) => matches(f.match, url));
      if (!mock) return { ok: false, reason: `No mock answers ${url}` };
      const r = mock.response;
      return { ok: true, status: r.status ?? 200, statusText: r.statusText ?? "OK", url: r.url ?? url, headers: r.headers ?? {}, body: r.body ?? "" };
    },
    "net.fetch.stream": (params) => {
      const url = String(params.url);
      const stream = String(params.stream);
      const mock = streams.find((s) => matches(s.match, url));
      if (!mock) throw new PluginError("failed", `No mock answers ${url}`);
      const r = mock.response;
      void (async () => {
        await tick();
        for (const data of r.chunks ?? []) {
          if (cancelled.has(stream)) return;
          event(CHANNEL_EVENTS.fetchChunk, { stream, data });
          await tick();
        }
        if (cancelled.has(stream)) return;
        if (r.error) event(CHANNEL_EVENTS.fetchError, { stream, message: r.error });
        else event(CHANNEL_EVENTS.fetchEnd, { stream });
      })();
      return { status: r.status ?? 200, statusText: r.statusText ?? "OK", headers: r.headers ?? {}, url: r.url ?? url };
    },
    "net.fetch.cancel": (params) => {
      cancelled.add(String(params.stream));
      return null;
    },
  };

  const answer = async (request: MockRequest) => {
    const handler = handlers.get(request.method) ?? defaults[request.method];
    await Promise.resolve();
    if (!handler) {
      if (options.strict) return deliver({ id: request.id, error: { code: "unknown-method", message: `The mock host has no handler for ${request.method}` } });
      return deliver({ id: request.id, result: null });
    }
    try {
      const result = await handler(request.params, request);
      deliver({ id: request.id, result: result === undefined ? null : result });
    } catch (error) {
      const code = error instanceof PluginError ? error.code : "failed";
      deliver({ id: request.id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  };

  const transport: Transport = {
    send(line) {
      const message = JSON.parse(line) as { id: number; method?: string; params?: Record<string, unknown> };
      if (typeof message.method !== "string") return;
      const request: MockRequest = { id: message.id, method: message.method, params: message.params ?? {} };
      sent.push(request);
      void answer(request);
    },
    onLine(listener) {
      listeners.push(listener);
    },
  };

  const runtime = createHostRuntime(transport, options.runtime);

  const settle = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) await tick();
    await runtime.whenIdle();
  };

  const call = <T>(message: Record<string, unknown>): Promise<T> => {
    const id = `c${++nextCall}`;
    const done = new Promise<T>((resolve, reject) => results.set(id, { resolve: resolve as (v: unknown) => void, reject }));
    deliver({ call: id, ...message });
    return done;
  };

  const view = (surfaceId: string): MockView => {
    const tree = () => trees.get(surfaceId)?.tree ?? null;
    const findAll = (predicate: (node: PluginNode) => boolean) => {
      const root = tree();
      if (!root) return [];
      const out: PluginNode[] = [];
      walk(root, out);
      return out.filter(predicate);
    };
    return {
      surfaceId,
      tree,
      findAll,
      find: (predicate) => findAll(predicate)[0] ?? null,
      byType: (type) => findAll((node) => node.type === type),
      text: () => {
        const root = tree();
        return root ? textOf(root) : "";
      },
      async trigger(node, prop, ...args) {
        const ref = node.props[prop] as { __handler?: unknown } | undefined;
        if (!ref || typeof ref.__handler !== "string") throw new Error(`${node.type} has no ${prop} handler`);
        deliver({ surface: "event", surfaceId, handlerId: ref.__handler, args });
        await settle();
      },
      async unmount() {
        deliver({ surface: "unmount", surfaceId });
        trees.delete(surfaceId);
        await settle();
      },
    };
  };

  return {
    runtime,
    ardia: runtime.ardia,
    transport,
    sent,
    storage,
    secrets,
    async load(definition) {
      await runtime.definePlugin(definition);
      await settle();
    },
    respond: (method, handler) => void handlers.set(method, handler),
    requests: (method) => sent.filter((r) => r.method === method).map((r) => r.params),
    runCommand: (name, input, context) => call({ kind: "command", name, ...(input !== undefined ? { input } : {}), ...(context ? { context } : {}) }),
    callTool: (name, input) => call({ kind: "tool", name, ...(input !== undefined ? { input } : {}) }),
    callService: (iface, method, input) => call({ kind: "service", name: iface, method, ...(input !== undefined ? { input } : {}) }),
    decide: (name, data = {}) => call({ kind: "decide", name, data }),
    omnibox: (query) => call({ kind: "omnibox", name: "omnibox", query }),
    cancel: (callId) => deliver({ call: callId, cancel: true }),
    async mountView(viewId, mount = {}) {
      const surfaceId = `s${++nextSurface}`;
      deliver({ surface: "mount", surfaceId, viewId, kind: mount.kind ?? "sidebar", ...(mount.context ? { context: mount.context } : {}) });
      await settle();
      return view(surfaceId);
    },
    async emit(name, data = {}) {
      event(name, data);
      await settle();
    },
    async emitState(topic, data) {
      event(`state.${topic}`, data);
      await settle();
    },
    async sendContentMessage(tabId, message, extra = {}) {
      event(CHANNEL_EVENTS.contentMessage, { tabId, message, ...extra });
      await settle();
    },
    async sendSidecarMessage(message) {
      event(CHANNEL_EVENTS.sidecarMessage, { message });
      await settle();
    },
    mockFetch: (match, response) => void fetches.unshift({ match, response }),
    mockFetchStream: (match, response) => void streams.unshift({ match, response }),
    settle,
    dispose: () => runtime.dispose(),
  };
}
