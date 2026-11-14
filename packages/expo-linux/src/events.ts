import { bridge } from "./bridge";
import { announceListener } from "./launchLinks";

export type EventSubscription = { remove(): void };

type Listener = (payload: unknown) => void;

const channel = (module: string, event: string) => `${module}:${event}`;
const listeners = new Map<string, Set<Listener>>();
const held = new Map<string, unknown[]>();

export function emitNativeEvent(module: string, event: string, payload: unknown) {
  const name = channel(module, event);
  const now = listeners.get(name);
  if (!now?.size) return;
  for (const listener of [...now]) {
    try {
      listener(payload);
    } catch (error) {
      console.error(`[ardia linux] ${name} listener failed`, error);
    }
  }
}

export function emitWhenListened(module: string, event: string, payload: unknown) {
  const name = channel(module, event);
  if (listeners.get(name)?.size) return emitNativeEvent(module, event, payload);
  held.set(name, [...(held.get(name) ?? []), payload]);
}

export function addNativeListener(module: string, event: string, listener: Listener): EventSubscription {
  const name = channel(module, event);
  const set = listeners.get(name) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(name, set);
  announceListener(module, event);
  const waiting = held.get(name);
  if (waiting) {
    held.delete(name);
    setTimeout(() => {
      for (const payload of waiting) emitNativeEvent(module, event, payload);
    }, 0);
  }
  return { remove: () => void set.delete(listener) };
}

let wired = false;

export function wireMainEvents() {
  if (wired) return;
  wired = true;
  bridge()?.onEvent((module, event, payload) => emitNativeEvent(module, event, payload));
}
