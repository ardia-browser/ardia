import type { CallKind, OmniboxSuggestion, PluginCallMessage } from "./protocol";
import { disposable, type CancelSignal } from "./types";

export type Signal = CancelSignal & { cancel(): void };

export function createSignal(): Signal {
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

export function cleanSuggestion(value: unknown): OmniboxSuggestion | null {
  if (typeof value !== "object" || value === null) return null;
  const { title, url, subtitle, icon, badge } = value as Record<string, unknown>;
  if (typeof title !== "string" || typeof url !== "string") return null;
  const out: OmniboxSuggestion = { title, url };
  if (typeof subtitle === "string") out.subtitle = subtitle;
  if (typeof icon === "string") out.icon = icon;
  if (typeof badge === "string") out.badge = badge;
  return out;
}

export function queryOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null) {
    const { query, text } = input as { query?: unknown; text?: unknown };
    if (typeof query === "string") return query;
    if (typeof text === "string") return text;
  }
  return "";
}

export const CALL_KINDS: readonly CallKind[] = ["tool", "command", "omnibox", "decide", "service"];

export function inputOf(kind: CallKind, message: PluginCallMessage): unknown {
  if (message.input !== undefined) return message.input;
  if (kind === "decide") return message.data;
  if (kind === "omnibox") return message.query;
  return undefined;
}
