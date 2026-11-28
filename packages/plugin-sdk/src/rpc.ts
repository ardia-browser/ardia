import type { HostReply } from "./protocol";

export type Transport = { send(line: string): void; onLine(listener: (line: string) => void): void };

export class PluginError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
}

export type Started<T> = { id: number; done: Promise<T> };

export type Rpc = {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  start<T = unknown>(method: string, params?: Record<string, unknown>, onId?: (id: number) => void): Started<T>;
  forget(id: number, reason: Error): void;
  send(message: Record<string, unknown>): void;
  takeReply(message: Record<string, unknown>): boolean;
  pendingCount(): number;
  close(reason: Error): void;
};

type Waiter = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

class LocalEncodingError extends PluginError {}

export function isUnencodable(error: unknown): boolean {
  return error instanceof LocalEncodingError;
}

function replyError(error: HostReply["error"]): PluginError {
  if (typeof error === "string") return new PluginError("failed", error);
  const code = typeof error?.code === "string" ? error.code : "failed";
  const message = typeof error?.message === "string" ? error.message : "The host refused the request.";
  return new PluginError(code, message);
}

export function createRpc(transport: Transport): Rpc {
  const waiting = new Map<number, Waiter>();
  let next = 0;
  let closedBy: Error | null = null;

  const send = (message: Record<string, unknown>) => transport.send(JSON.stringify(message));

  function start<T>(method: string, params: Record<string, unknown> = {}, onId?: (id: number) => void): Started<T> {
    const id = ++next;
    onId?.(id);
    if (closedBy) return { id, done: Promise.reject(closedBy) };
    let line: string;
    try {
      line = JSON.stringify({ id, method, params });
    } catch (error) {
      return { id, done: Promise.reject(new LocalEncodingError("unencodable", `The ${method} request couldn't be encoded: ${errorMessage(error)}`)) };
    }
    const done = new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        transport.send(line);
      } catch (error) {
        waiting.delete(id);
        reject(error);
      }
    });
    return { id, done };
  }

  return {
    send,
    request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      return start<T>(method, params).done;
    },
    start,
    forget(id, reason) {
      const waiter = waiting.get(id);
      if (!waiter) return;
      waiting.delete(id);
      waiter.reject(reason);
    },
    takeReply(message) {
      if (typeof message.method === "string" || !("id" in message)) return false;
      if (!("result" in message) && !("error" in message)) return false;
      const id = message.id;
      const waiter = typeof id === "number" ? waiting.get(id) : undefined;
      if (!waiter) return true;
      waiting.delete(id as number);
      const reply = message as HostReply;
      if (reply.error !== undefined && reply.error !== null) waiter.reject(replyError(reply.error));
      else waiter.resolve(reply.result);
      return true;
    },
    pendingCount: () => waiting.size,
    close(reason) {
      if (closedBy) return;
      closedBy = reason;
      const waiters = [...waiting.values()];
      waiting.clear();
      for (const waiter of waiters) waiter.reject(reason);
    },
  };
}
