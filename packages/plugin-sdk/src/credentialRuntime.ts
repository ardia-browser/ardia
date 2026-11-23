import { CREDENTIAL_CALL_KIND, CREDENTIAL_HANDLERS, CREDENTIAL_LIMITS, CREDENTIALS_PROTOCOL, CREDENTIALS_SDK_VERSION } from "./credentialConstants";
import { credentialContext, lineOf, type CallMessage, type Requester, type Sent, type VerbHooks } from "./credentialContext";
import { isRecord, utf8Length } from "./credentialData";
import { CredentialError, wireErrorOf } from "./credentialErrors";
import type { CredentialContext, CredentialHandler, CredentialHandlerName, CredentialProvider, ItemPage, ListRequest, ListedItem } from "./credentialTypes";
import { PLUGIN_PROTOCOL } from "./protocol";
import { PluginError, errorMessage, type Transport } from "./rpc";
import { disposable, type CancelSignal } from "./types";

type Signal = CancelSignal & { cancel(): void };

type Waiter = VerbHooks & { resolve(value: unknown): void; reject(error: unknown): void; parts: string[]; itemError?: unknown };

type HeldListing = { pages: ListedItem[][]; touched: number };

export type CredentialRuntimeOptions = { onError?: (error: unknown) => void; now?: () => number };

export type CredentialRuntime = { define(provider: CredentialProvider): Promise<void>; callCount(): number; dispose(): void };

const PAGE_ENVELOPE_BYTES = 512;

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

type AnyHandler = CredentialHandler<never, unknown>;

function handlerOf(provider: CredentialProvider, name: CredentialHandlerName): AnyHandler | undefined {
  if (name === "passkeys.list") return provider.passkeys?.list as AnyHandler | undefined;
  if (name === "passkeys.get") return provider.passkeys?.get as AnyHandler | undefined;
  if (name === "passkeys.save") return provider.passkeys?.save as AnyHandler | undefined;
  const handler = provider[name];
  return typeof handler === "function" ? (handler as AnyHandler) : undefined;
}

export function credentialHandlersOf(provider: CredentialProvider): CredentialHandlerName[] {
  return CREDENTIAL_HANDLERS.filter((name) => handlerOf(provider, name) !== undefined);
}

export function pageItems(items: readonly ListedItem[], pageBytes: number = CREDENTIAL_LIMITS.pageBytes): ListedItem[][] {
  const pages: ListedItem[][] = [];
  let page: ListedItem[] = [];
  let bytes = PAGE_ENVELOPE_BYTES;
  for (const item of items) {
    const size = utf8Length(JSON.stringify(item)) + 1;
    if (page.length && bytes + size > pageBytes) {
      pages.push(page);
      page = [];
      bytes = PAGE_ENVELOPE_BYTES;
    }
    page.push(item);
    bytes += size;
  }
  pages.push(page);
  return pages;
}

const isHandlerName = (name: unknown): name is CredentialHandlerName => typeof name === "string" && (CREDENTIAL_HANDLERS as readonly string[]).includes(name);

export function createCredentialRuntime(transport: Transport, options: CredentialRuntimeOptions = {}): CredentialRuntime {
  const waiting = new Map<number, Waiter>();
  const calls = new Map<string, Signal>();
  const held = new Map<string, HeldListing>();
  const now = options.now ?? (() => Date.now());
  let nextId = 0;
  let snapshots = 0;
  let provider: CredentialProvider | null = null;
  let activation: Promise<boolean> = Promise.resolve(false);
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;

  const report = (error: unknown) => {
    if (options.onError) options.onError(error);
    else (globalThis as { console?: { error?: (...args: unknown[]) => void } }).console?.error?.("[ardia credentials]", error);
  };

  const request: Requester = (method, params, hooks = {}): Sent => {
    const id = ++nextId;
    const parts: string[] = [];
    if (stopped) return { id, parts, promise: Promise.reject(new PluginError("stopped", "The plugin stopped.")) };
    let line: string;
    try {
      line = JSON.stringify({ id, method, params });
    } catch (error) {
      return { id, parts, promise: Promise.reject(new PluginError("unencodable", `The ${method} request couldn't be encoded: ${errorMessage(error)}`)) };
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      waiting.set(id, { resolve, reject, parts, ...hooks });
      try {
        transport.send(line);
      } catch (error) {
        waiting.delete(id);
        reject(error);
      }
    });
    return { id, parts, promise };
  };

  function takeReply(record: Record<string, unknown>): boolean {
    if (typeof record.method === "string" || typeof record.id !== "number") return false;
    if (!("result" in record) && !("error" in record)) return false;
    const waiter = waiting.get(record.id);
    if (!waiter) return true;
    waiting.delete(record.id);
    const error = record.error;
    if (error !== undefined && error !== null) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "failed";
      const message = isRecord(error) && typeof error.message === "string" ? error.message : typeof error === "string" ? error : "The host refused the request.";
      waiter.reject(code === "stale" ? CredentialError.locked() : new PluginError(code, message));
    } else if (waiter.itemError !== undefined) waiter.reject(waiter.itemError);
    else waiter.resolve(record.result);
    return true;
  }

  function takeNotice(record: Record<string, unknown>): boolean {
    if (typeof record.verbOf !== "number") return false;
    const waiter = waiting.get(record.verbOf);
    if (!waiter || waiter.itemError !== undefined) return true;
    try {
      if ("item" in record) waiter.onItem?.(record.item, typeof record.index === "number" ? record.index : 0);
      else if ("line" in record) {
        const line = lineOf(record.line);
        if (line) waiter.onLine?.(line);
      } else if (typeof record.part === "string") waiter.parts.push(record.part);
    } catch (error) {
      waiter.itemError = error;
    }
    return true;
  }

  function forgetOldListings() {
    const oldest = now() - CREDENTIAL_LIMITS.heldSnapshotMs;
    for (const [snapshot, listing] of held) if (listing.touched < oldest) held.delete(snapshot);
  }

  function pageFrom(snapshot: string, pages: ListedItem[][], index: number): ItemPage {
    const page: ItemPage = { snapshot, items: pages[index] ?? [] };
    if (index + 1 < pages.length) page.cursor = String(index + 1);
    else held.delete(snapshot);
    return page;
  }

  async function list(input: unknown, ctx: CredentialContext, handler: CredentialProvider["list"]): Promise<unknown> {
    forgetOldListings();
    const asked: ListRequest = isRecord(input) ? { snapshot: typeof input.snapshot === "string" ? input.snapshot : null, cursor: typeof input.cursor === "string" ? input.cursor : null } : { snapshot: null, cursor: null };
    const kept = asked.snapshot ? held.get(asked.snapshot) : undefined;
    const index = asked.cursor !== null && /^[1-9][0-9]{0,8}$/.test(asked.cursor) ? Number(asked.cursor) : -1;
    if (kept && asked.snapshot && index > 0 && index < kept.pages.length) {
      kept.touched = now();
      return pageFrom(asked.snapshot, kept.pages, index);
    }
    const listed = await handler(kept || !asked.snapshot ? { snapshot: null, cursor: null } : asked, ctx);
    if (!Array.isArray(listed)) return listed;
    const pages = pageItems(listed as ListedItem[]);
    const snapshot = `s${(++snapshots).toString(36)}${Math.floor(now()).toString(36)}`;
    if (pages.length > 1) held.set(snapshot, { pages, touched: now() });
    return pageFrom(snapshot, pages, 0);
  }

  async function dispatch(name: CredentialHandlerName, input: unknown, ctx: CredentialContext): Promise<unknown> {
    const current = provider;
    if (!current) throw CredentialError.unsupported();
    if (name === "list") return list(input, ctx, current.list);
    const handler = handlerOf(current, name);
    if (!handler) throw CredentialError.unsupported();
    return handler((input ?? {}) as never, ctx);
  }

  async function sendResult(body: Record<string, unknown>) {
    try {
      await request("result", body).promise;
    } catch (error) {
      if (error instanceof PluginError && error.code === "unencodable") {
        await request("result", { call: body.call, error: { code: "failed", problem: "failed", detail: "The plugin's result couldn't be sent." } }).promise.catch(report);
      } else if (!stopped) report(error);
    }
  }

  async function answer(message: Record<string, unknown>, signal: Signal) {
    const callId = message.call as string;
    try {
      if (signal.cancelled) return;
      const name = message.name;
      if (message.kind !== CREDENTIAL_CALL_KIND || !isHandlerName(name)) return await sendResult({ call: callId, error: CredentialError.unsupported().toWire() });
      const ctx = credentialContext({ ...(message as CallMessage), call: callId, name }, signal, request, () => stopped);
      let body: Record<string, unknown>;
      try {
        const result = await dispatch(name, message.input, ctx);
        body = { call: callId, result: result === undefined ? null : result };
      } catch (error) {
        body = { call: callId, error: wireErrorOf(error) };
      }
      if (signal.cancelled || stopped) return;
      signal.cancel();
      await sendResult(body);
    } finally {
      if (calls.get(callId) === signal) calls.delete(callId);
      signal.cancel();
    }
  }

  function handleLine(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return report(new Error(`The host sent a line that isn't JSON: ${line.slice(0, 120)}`));
    }
    if (!isRecord(message)) return;
    if (takeNotice(message) || takeReply(message) || stopped) return;
    if (typeof message.call === "string") {
      const callId = message.call;
      if (message.cancel === true) return calls.get(callId)?.cancel();
      if (calls.has(callId)) return;
      const signal = createSignal();
      calls.set(callId, signal);
      const record = message;
      queue = queue
        .then(() => activation)
        .then((ready) => {
          if (ready) void answer(record, signal).catch(report);
          else if (calls.get(callId) === signal) calls.delete(callId);
        })
        .catch(report);
      return;
    }
    if (message.event === "plugin.stopping") dispose();
  }

  function dispose() {
    if (stopped) return;
    stopped = true;
    for (const signal of [...calls.values()]) signal.cancel();
    calls.clear();
    held.clear();
    const waiters = [...waiting.values()];
    waiting.clear();
    for (const waiter of waiters) waiter.reject(new PluginError("stopped", "The plugin stopped."));
  }

  transport.onLine((line) => {
    try {
      handleLine(line);
    } catch (error) {
      report(error);
    }
  });

  function define(definition: CredentialProvider): Promise<void> {
    if (provider) return Promise.reject(new Error("This plugin already defined its credential provider."));
    provider = definition;
    const handlers = credentialHandlersOf(definition);
    activation = (async () => {
      try {
        const hello = await request("hello", { protocol: PLUGIN_PROTOCOL, sdk: CREDENTIALS_SDK_VERSION, credentials: CREDENTIALS_PROTOCOL }).promise;
        const spoken = isRecord(hello) && isRecord(hello.credentials) ? hello.credentials : null;
        const supported = spoken && Array.isArray(spoken.supported) ? spoken.supported : [];
        if (!supported.includes(CREDENTIALS_PROTOCOL)) throw new PluginError("refused", `This Ardia doesn't speak credentials protocol ${CREDENTIALS_PROTOCOL}.`);
        if (stopped) return false;
        await request("ready", { commands: [], tools: [], views: [], omnibox: false, decide: [], events: [], credentialProvider: { handlers } }).promise;
        return !stopped;
      } catch (error) {
        report(error);
        return false;
      }
    })();
    return activation.then(() => undefined);
  }

  return { define, callCount: () => calls.size, dispose };
}

let shared: CredentialRuntime | null = null;

function bridge(): Transport {
  const found = (globalThis as { __ardiaBridge?: Transport }).__ardiaBridge;
  if (!found || typeof found.send !== "function" || typeof found.onLine !== "function") {
    throw new Error("There's no __ardiaBridge; plugins built with @ardia/plugin-sdk run inside Ardia's plugin host.");
  }
  return found;
}

export function defineCredentialProvider(provider: CredentialProvider): Promise<void> {
  shared ??= createCredentialRuntime(bridge());
  return shared.define(provider);
}
