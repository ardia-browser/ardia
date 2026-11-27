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

export type RequestOptions = { replyBytes?: number };

export type Rpc = {
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  send(message: Record<string, unknown>): void;
  takeReply(message: Record<string, unknown>): boolean;
  pendingCount(): number;
  inFlightBytes(): number;
  close(reason: Error): void;
};

type Waiter = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

export function unwrap(result: unknown, key: string): unknown {
  if (typeof result === "object" && result !== null && !Array.isArray(result) && key in result) return (result as Record<string, unknown>)[key];
  return result;
}

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

export const MAX_IN_FLIGHT = 16;
export const MAX_IN_FLIGHT_BYTES = 12 << 20;
export const SMALL_REPLY_BYTES = 4096;

export const MAX_READ_BYTES = 4 << 20;

export const readReplyBytes = (length: number | undefined) => {
  const wanted = typeof length === "number" && Number.isFinite(length) && length >= 0 ? Math.min(length, MAX_READ_BYTES) : MAX_READ_BYTES;
  return Math.ceil(wanted / 3) * 4 + 512;
};

const replyCost = (options: RequestOptions) =>
  typeof options.replyBytes === "number" && Number.isFinite(options.replyBytes) && options.replyBytes > 0 ? Math.ceil(options.replyBytes) : SMALL_REPLY_BYTES;

export function createRpc(transport: Transport): Rpc {
  const waiting = new Map<number, Waiter>();
  let next = 0;
  let closedBy: Error | null = null;

  const send = (message: Record<string, unknown>) => transport.send(JSON.stringify(message));
  const queued: { id: number; line: string; cost: number; waiter: Waiter }[] = [];
  const costs = new Map<number, number>();
  let inFlightBytes = 0;
  const settle = (id: number) => {
    inFlightBytes -= costs.get(id) ?? 0;
    costs.delete(id);
    waiting.delete(id);
  };
  const fits = (cost: number) => waiting.size === 0 || (waiting.size < MAX_IN_FLIGHT && inFlightBytes + cost <= MAX_IN_FLIGHT_BYTES);
  const pump = () => {
    while (queued.length && !closedBy && fits(queued[0]!.cost)) {
      const { id, line, cost, waiter } = queued.shift()!;
      waiting.set(id, waiter);
      costs.set(id, cost);
      inFlightBytes += cost;
      try {
        transport.send(line);
      } catch (error) {
        settle(id);
        waiter.reject(error);
      }
    }
  };

  return {
    send,
    request<T>(method: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<T> {
      if (closedBy) return Promise.reject(closedBy);
      const id = ++next;
      let line: string;
      try {
        line = JSON.stringify({ id, method, params });
      } catch (error) {
        return Promise.reject(new LocalEncodingError("unencodable", `The ${method} request couldn't be encoded: ${errorMessage(error)}`));
      }
      return new Promise<T>((resolve, reject) => {
        queued.push({ id, line, cost: line.length + replyCost(options), waiter: { resolve: resolve as (value: unknown) => void, reject } });
        pump();
      });
    },
    takeReply(message) {
      if (typeof message.method === "string" || !("id" in message)) return false;
      if (!("result" in message) && !("error" in message)) return false;
      const id = message.id;
      const waiter = typeof id === "number" ? waiting.get(id) : undefined;
      if (!waiter) return true;
      settle(id as number);
      const reply = message as HostReply;
      if (reply.error !== undefined && reply.error !== null) waiter.reject(replyError(reply.error));
      else waiter.resolve(reply.result);
      pump();
      return true;
    },
    pendingCount: () => waiting.size + queued.length,
    inFlightBytes: () => inFlightBytes,
    close(reason) {
      if (closedBy) return;
      closedBy = reason;
      const waiters = [...waiting.values(), ...queued.splice(0).map((q) => q.waiter)];
      waiting.clear();
      costs.clear();
      inFlightBytes = 0;
      for (const waiter of waiters) waiter.reject(reason);
    },
  };
}
