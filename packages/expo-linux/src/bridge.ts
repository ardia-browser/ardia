export type ModuleShape = { sync: string[]; async: string[]; constants?: Record<string, unknown> };

export type BridgeReply = { value?: unknown; error?: string; code?: string };

export type LinuxBridge = {
  modules(): Record<string, ModuleShape>;
  callSync(module: string, method: string, args: unknown[]): unknown;
  call(module: string, method: string, args: unknown[]): Promise<unknown>;
  callSyncRaw?(module: string, method: string, args: unknown[]): BridgeReply;
  callRaw?(module: string, method: string, args: unknown[]): Promise<BridgeReply>;
  onEvent(listener: (module: string, event: string, payload: unknown) => void): () => void;
};

export class NativeCallError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly module: string,
    readonly method: string,
  ) {
    super(message);
    this.name = "NativeCallError";
  }
}

let shapes: Record<string, ModuleShape> | null = null;

export const bridge = (): LinuxBridge | null => (globalThis as { ardiaLinux?: LinuxBridge }).ardiaLinux ?? null;

export const mainModules = (): Record<string, ModuleShape> => (shapes ??= bridge()?.modules() ?? {});

function unwrap(module: string, method: string, reply: BridgeReply | null | undefined): unknown {
  if (reply && typeof reply.error === "string") throw new NativeCallError(reply.error, reply.code ?? "ERR_LINUX_NATIVE", module, method);
  return reply?.value;
}

export function invokeMainSync(linux: LinuxBridge, module: string, method: string, args: unknown[]): unknown {
  if (linux.callSyncRaw) return unwrap(module, method, linux.callSyncRaw(module, method, args));
  return linux.callSync(module, method, args);
}

export async function invokeMain(linux: LinuxBridge, module: string, method: string, args: unknown[]): Promise<unknown> {
  if (linux.callRaw) return unwrap(module, method, await linux.callRaw(module, method, args));
  return linux.call(module, method, args);
}

export function callMainSync<Value = unknown>(module: string, method: string, ...args: unknown[]): Value | undefined {
  const linux = bridge();
  if (!linux || !mainModules()[module]?.sync.includes(method)) return undefined;
  return invokeMainSync(linux, module, method, args) as Value;
}

export async function callMain<Value = unknown>(module: string, method: string, ...args: unknown[]): Promise<Value | undefined> {
  const linux = bridge();
  const shape = mainModules()[module];
  if (!linux || !(shape?.async.includes(method) || shape?.sync.includes(method))) return undefined;
  return (await invokeMain(linux, module, method, args)) as Value;
}
