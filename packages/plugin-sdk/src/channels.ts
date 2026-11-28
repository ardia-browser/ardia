import {
  CHANNEL_EVENTS as E,
  HOST_METHODS_V3 as M,
  type ContentMessageEvent,
  type StreamFetchRequest,
  type StreamHead,
  type WsConnectParams,
} from "./protocol";
import { chunkQueue } from "./chunkQueue";
import { enqueueMicrotask } from "./reconciler";
import { PluginError, type Rpc } from "./rpc";
import { addTo, type Disposable } from "./types";

export type AbortSignalLike = {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
};

export type StreamResponse = StreamHead & {
  ok: boolean;
  body: AsyncIterable<string>;
  text(): Promise<string>;
  cancel(): Promise<void>;
};

export type StreamFetchInit = Omit<StreamFetchRequest, "url"> & { signal?: AbortSignalLike };

export type SocketState = "connecting" | "open" | "closing" | "closed";

export type PluginSocket = {
  readonly id: string;
  readonly url: string;
  readonly protocol: string;
  readonly state: SocketState;
  send(data: string): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
  onMessage(listener: (data: string, binary: boolean) => void): Disposable;
  onClose(listener: (code: number, reason: string) => void): Disposable;
  onError(listener: (message: string) => void): Disposable;
};

export type ConnectOptions = { protocols?: string[]; headers?: Record<string, string>; signal?: AbortSignalLike };

type Stream = { push(data: string): void; end(): void; fail(error: unknown, fromHost?: boolean): void };

type Socket = { opened(protocol: string): void; message(data: string, binary: boolean): void; closed(code: number, reason: string): void; failed(message: string): void };

const abortError = (signal: AbortSignalLike) =>
  signal.reason instanceof Error ? signal.reason : new PluginError("aborted", typeof signal.reason === "string" ? signal.reason : "The request was aborted.");

const MAX_HELD_MESSAGES = 256;

type SocketEvent = { kind: "message"; data: string; binary: boolean } | { kind: "error"; message: string } | { kind: "close"; code: number; reason: string };

const quiet = () => undefined;

export type Channels = ReturnType<typeof createChannels>;

export function createChannels(rpc: Rpc, report: (error: unknown) => void) {
  const streams = new Map<string, Stream>();
  const sockets = new Map<string, Socket>();
  const sidecarListeners = new Set<(message: unknown) => void>();
  const contentListeners = new Set<(event: ContentMessageEvent) => void>();
  let next = 0;

  const safely = (listener: () => void) => {
    try {
      listener();
    } catch (error) {
      report(error);
    }
  };

  function deliver(name: string, data: Record<string, unknown>): boolean {
    const stream = typeof data.stream === "string" ? streams.get(data.stream) : undefined;
    const socket = typeof data.socket === "string" ? sockets.get(data.socket) : undefined;
    switch (name) {
      case E.fetchChunk:
        if (typeof data.data === "string") stream?.push(data.data);
        return true;
      case E.fetchEnd:
        stream?.end();
        return true;
      case E.fetchError:
        stream?.fail(new PluginError(typeof data.code === "string" ? data.code : "failed", typeof data.message === "string" ? data.message : "The stream failed."));
        return true;
      case E.wsOpen:
        socket?.opened(typeof data.protocol === "string" ? data.protocol : "");
        return true;
      case E.wsMessage:
        if (typeof data.data === "string") socket?.message(data.data, data.binary === true);
        return true;
      case E.wsClose:
        socket?.closed(typeof data.code === "number" ? data.code : 1006, typeof data.reason === "string" ? data.reason : "");
        return true;
      case E.wsError:
        socket?.failed(typeof data.message === "string" ? data.message : "The connection failed.");
        return true;
      case E.sidecarMessage:
        for (const listener of [...sidecarListeners]) safely(() => listener(data.message));
        return true;
      case E.contentMessage:
        if (typeof data.tabId === "string") {
          const event: ContentMessageEvent = { tabId: data.tabId, message: data.message };
          if (typeof data.frameId === "number") event.frameId = data.frameId;
          if (typeof data.scriptId === "string") event.scriptId = data.scriptId;
          for (const listener of [...contentListeners]) safely(() => listener(event));
        }
        return true;
      default:
        return false;
    }
  }

  async function fetchStream(input: string | (StreamFetchRequest & { signal?: AbortSignalLike }), init: StreamFetchInit = {}): Promise<StreamResponse> {
    const { signal, ...request } = typeof input === "string" ? { ...init, url: input } : { ...input, ...init };
    if (signal?.aborted) throw abortError(signal);
    const id = `f${++next}`;
    let cancelled = false;
    let rejectHead: ((error: unknown) => void) | null = null;
    let headId = 0;
    const cancelRemote = () => {
      if (cancelled) return Promise.resolve();
      cancelled = true;
      return rpc.request(M.fetchCancel, { stream: id }).then(undefined, quiet);
    };
    const queue = chunkQueue(
      () => {
        streams.delete(id);
        signal?.removeEventListener("abort", onAbort);
      },
      (error, fromHost) => {
        if (rejectHead) {
          rejectHead(error);
          rpc.forget(headId, error instanceof Error ? error : new PluginError("failed", String(error)));
        }
        if (!fromHost) void cancelRemote();
      },
    );
    const cancel = async () => {
      if (cancelled || queue.ended) return;
      queue.end();
      await cancelRemote();
    };
    function onAbort() {
      queue.fail(abortError(signal!), false);
    }
    streams.set(id, queue);
    signal?.addEventListener("abort", onAbort, { once: true });
    const head = await new Promise<StreamHead>((resolve, reject) => {
      rejectHead = reject;
      rpc.start<StreamHead>(M.fetchStream, { ...request, stream: id }, (requestId) => (headId = requestId)).done.then(resolve, (error) => {
        rejectHead = null;
        queue.fail(error, true);
        reject(error);
      });
    });
    rejectHead = null;
    let consumed = false;
    const body: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        if (consumed) throw new PluginError("used", "A stream's body can be read once.");
        consumed = true;
        return {
          next: () => queue.next(),
          return: async () => {
            await cancel();
            return { value: undefined, done: true };
          },
        };
      },
    };
    return {
      status: head.status,
      statusText: head.statusText ?? "",
      headers: head.headers ?? {},
      url: head.url ?? request.url,
      ok: head.status >= 200 && head.status < 300,
      body,
      async text() {
        let out = "";
        for await (const chunk of body) out += chunk;
        return out;
      },
      cancel,
    };
  }

  function connect(url: string, options: ConnectOptions = {}): Promise<PluginSocket> {
    const id = `w${++next}`;
    const listeners = { message: new Set<(data: string, binary: boolean) => void>(), close: new Set<(code: number, reason: string) => void>(), error: new Set<(message: string) => void>() };
    let state: SocketState = "connecting";
    let protocol = "";
    let settle: { resolve: () => void; reject: (error: unknown) => void } | null = null;
    const pending: SocketEvent[] = [];
    let draining = false;
    let deferredFlush = false;
    const listening = (event: SocketEvent) => listeners[event.kind].size > 0;
    const deliverOne = (event: SocketEvent) => {
      if (event.kind === "message") for (const l of [...listeners.message]) safely(() => l(event.data, event.binary));
      else if (event.kind === "error") for (const l of [...listeners.error]) safely(() => l(event.message));
      else for (const l of [...listeners.close]) safely(() => l(event.code, event.reason));
    };
    const drain = (allowSkip = false) => {
      if (draining) return;
      draining = true;
      try {
        for (;;) {
          if (!pending.length) return;
          if (listening(pending[0]!)) {
            deliverOne(pending.shift()!);
            continue;
          }
          let last = -1;
          for (let i = pending.length - 1; i >= 0; i--) {
            if (listening(pending[i]!)) {
              last = i;
              break;
            }
          }
          if (last < 0) return;
          if (!allowSkip) {
            if (!deferredFlush) {
              deferredFlush = true;
              enqueueMicrotask(() => {
                deferredFlush = false;
                drain(true);
              });
            }
            return;
          }
          for (const event of pending.splice(0, last + 1)) if (listening(event)) deliverOne(event);
        }
      } finally {
        draining = false;
      }
    };
    const emit = (event: SocketEvent) => {
      pending.push(event);
      drain(false);
      if (pending[pending.length - 1] !== event) return;
      if (event.kind === "message") {
        let messages = 0;
        for (const item of pending) if (item.kind === "message") messages++;
        if (messages > MAX_HELD_MESSAGES) pending.pop();
      } else if (event.kind === "error") {
        let errors = 0;
        for (const item of pending) if (item.kind === "error") errors++;
        if (errors > 16) pending.pop();
      }
    };
    const attach = <K extends keyof typeof listeners>(kind: K, listener: Parameters<(typeof listeners)[K]["add"]>[0]): Disposable => {
      const added = addTo(listeners[kind] as Set<typeof listener>, listener);
      drain(false);
      return added;
    };
    const forget = () => {
      sockets.delete(id);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const socket: PluginSocket = {
      id,
      url,
      get protocol() {
        return protocol;
      },
      get state() {
        return state;
      },
      send: (data) => {
        if (state !== "open") return Promise.reject(new PluginError("closed", "The socket isn't open."));
        return rpc.request(M.wsSend, { socket: id, data }).then(() => undefined);
      },
      close: (code = 1000, reason = "") => {
        if (state === "closed" || state === "closing") return Promise.resolve();
        const before = state;
        state = "closing";
        return rpc.request(M.wsClose, { socket: id, code, reason }).then(
          () => undefined,
          (error) => {
            if (state === "closing") state = before;
            throw error;
          },
        );
      },
      onMessage: (listener) => attach("message", listener),
      onClose: (listener) => attach("close", listener),
      onError: (listener) => attach("error", listener),
    };
    sockets.set(id, {
      opened(given) {
        if (state !== "connecting") return;
        state = "open";
        protocol = given;
        settle?.resolve();
      },
      message(data, binary) {
        if (state === "closed") return;
        emit({ kind: "message", data, binary });
      },
      closed(code, reason) {
        if (state === "closed") return;
        state = "closed";
        forget();
        handshakeFailed(new PluginError("closed", reason || `The socket closed (${code}) before it opened.`));
        emit({ kind: "close", code, reason });
      },
      failed(message) {
        if (state === "connecting") {
          state = "closed";
          forget();
          handshakeFailed(new PluginError("failed", message));
        }
        emit({ kind: "error", message });
      },
    });
    let connectId = 0;
    function handshakeFailed(error: Error) {
      if (!settle) return;
      settle.reject(error);
      rpc.forget(connectId, error);
    }
    function onAbort() {
      if (state === "connecting") {
        state = "closed";
        forget();
        handshakeFailed(abortError(options.signal!) as Error);
        void rpc.request(M.wsClose, { socket: id, code: 1000, reason: "aborted" }).then(undefined, quiet);
        return;
      }
      void socket.close(1000, "aborted").catch(report);
    }
    if (options.signal?.aborted) {
      forget();
      return Promise.reject(abortError(options.signal));
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const params: WsConnectParams = { socket: id, url, ...(options.protocols ? { protocols: options.protocols } : {}), ...(options.headers ? { headers: options.headers } : {}) };
    return new Promise<PluginSocket>((resolve, reject) => {
      settle = {
        resolve: () => {
          settle = null;
          resolve(socket);
        },
        reject: (error) => {
          settle = null;
          reject(error);
        },
      };
      rpc.start<{ protocol?: string; open?: boolean }>(M.wsConnect, { ...params }, (requestId) => (connectId = requestId)).done.then(
        (reply) => {
          if (reply && reply.open === true) sockets.get(id)?.opened(typeof reply.protocol === "string" ? reply.protocol : "");
        },
        (error) => {
          state = "closed";
          forget();
          settle?.reject(error);
        },
      );
    });
  }

  return {
    deliver,
    fetchStream,
    connect,
    onSidecarMessage: (listener: (message: unknown) => void): Disposable => addTo(sidecarListeners, listener),
    onContentMessage: (listener: (event: ContentMessageEvent) => void): Disposable => addTo(contentListeners, listener),
    openCount: () => streams.size + sockets.size,
    closeAll() {
      const error = new PluginError("stopped", "The plugin stopped.");
      for (const stream of [...streams.values()]) stream.fail(error, false);
      for (const [socket, entry] of [...sockets]) {
        void rpc.request(M.wsClose, { socket, code: 1001, reason: "The plugin stopped." }).then(undefined, quiet);
        entry.closed(1001, "The plugin stopped.");
      }
      streams.clear();
      sockets.clear();
      sidecarListeners.clear();
      contentListeners.clear();
    },
  };
}
