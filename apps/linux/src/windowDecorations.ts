import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";
import { noteLinuxWindowDecorations } from "../../browser/src/state/telemetry/windowPlacementCounts.ts";

export const WINDOW_DECORATIONS_METHOD = "ArdiaShell.windowDecorations";
const WINDOW_DECORATIONS_EVENT = "windowDecorations";

type Decorations = { decoratedBy: unknown; answer: unknown };
type Note = (decoratedBy: unknown, answer: unknown) => void;

const isDecorations = (value: unknown): value is Decorations => !!value && typeof value === "object" && "decoratedBy" in value && "answer" in value;

export function watchWindowDecorations(host: ArdiaHost, windowId: string, note: Note = noteLinuxWindowDecorations): () => void {
  if (!hostSupports(WINDOW_DECORATIONS_METHOD, host)) return () => {};
  let last = "";
  const record = (value: unknown) => {
    if (!isDecorations(value)) return;
    const key = `${String(value.decoratedBy)}/${String(value.answer)}`;
    if (key === last) return;
    last = key;
    note(value.decoratedBy, value.answer);
  };
  const stop = host.onEvent((module, event, payload) => {
    if (module === "ArdiaShell" && event === WINDOW_DECORATIONS_EVENT && isDecorations(payload) && (payload as { windowId?: unknown }).windowId === windowId) record(payload);
  });
  void invokeHost<unknown>(WINDOW_DECORATIONS_METHOD, { args: [windowId] }, host).then(record, () => {});
  return stop;
}
