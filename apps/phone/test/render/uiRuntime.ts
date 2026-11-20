type Worklet = ((...args: unknown[]) => unknown) & {
  __workletHash?: number;
  __closure?: Record<string, unknown> | unknown[];
  __initData?: { code: string; location?: string };
};

export type RemoteFunction = { __remoteFunction: (...args: unknown[]) => unknown };

const trusted = new WeakSet<object>();
const copies = new WeakMap<object, Worklet>();

export const trust = <T extends object>(value: T): T => {
  trusted.add(value);
  return value;
};

const isRemote = (value: unknown): value is RemoteFunction => typeof value === "object" && value !== null && "__remoteFunction" in value;

export const fromRemote = (value: unknown): unknown => (isRemote(value) ? value.__remoteFunction : value);

const isLibraryWorklet = (fn: Worklet) => Boolean(fn.__workletHash) && (!fn.__initData || (fn.__initData.location ?? "").includes("node_modules"));

function shared(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value === "function") {
    const fn = value as Worklet;
    if (trusted.has(fn) || isLibraryWorklet(fn)) return fn;
    if (fn.__workletHash && fn.__initData) return onUiThread(fn);
    return { __remoteFunction: fn } satisfies RemoteFunction;
  }
  if (typeof value !== "object" || value === null || isRemote(value) || "_isReanimatedSharedValue" in value) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return value;
  if (seen.has(value)) return seen.get(value);
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, inner] of Object.entries(value)) (copy as Record<string, unknown>)[key] = shared(inner, seen);
  return copy;
}

export function onUiThread<T>(value: T): T {
  if (typeof value !== "function") return value;
  const fn = value as unknown as Worklet;
  if (!fn.__workletHash || !fn.__initData || isLibraryWorklet(fn) || trusted.has(fn)) return value;
  const known = copies.get(fn);
  if (known) return known as unknown as T;
  const compiled = new Function(`return (${fn.__initData.code})`)() as Worklet;
  const closure = shared(fn.__closure ?? [], new Map());
  const copy = compiled.bind({ __closure: closure }) as Worklet;
  copy.__workletHash = fn.__workletHash;
  copy.__closure = fn.__closure;
  copies.set(fn, copy);
  trust(copy);
  return copy as unknown as T;
}

export function workletOnly<T>(value: T): T {
  if (typeof value !== "function") return value;
  const fn = value as unknown as Worklet;
  if (fn.__workletHash || trusted.has(fn)) return value;
  const name = fn.name || "anonymous";
  return (() => {
    throw new Error(`[Worklets] Tried to synchronously call a Remote Function. Called "${name}" on the UI Runtime.`);
  }) as unknown as T;
}
