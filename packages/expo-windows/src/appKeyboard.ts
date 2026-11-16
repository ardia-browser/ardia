import type { Fiber } from "./fiber";
import type { FocusOnWindows } from "./textFocus";

type TakesKeyboard = Pick<FocusOnWindows, "takeKeyboardFromPage">;
type FocusedField = { field: unknown; windowId: string; contentAreaOf?: string } | null;
type FieldPlace = { windowId: string; contentAreaOf: string };

const MOST_ANCESTORS = 4096;

let readFocusedField: () => FocusedField = () => null;
const pressedOver = new Map<string, unknown>();
const fieldAskedListeners = new Set<() => void>();

export function onFieldAsked(listener: () => void): () => void {
  fieldAskedListeners.add(listener);
  return () => void fieldAskedListeners.delete(listener);
}

export function fieldKeepsKeyboardFrom(windowId: string, forTab: string): boolean {
  const focused = readFocusedField();
  if (focused?.windowId && focused.windowId !== windowId) return pressedOver.get(focused.windowId) !== focused.field;
  return fieldFocusedIn(windowId, forTab);
}

export function focusedFieldInAnotherTab(tab: string): boolean {
  const contentAreaOf = readFocusedField()?.contentAreaOf;
  return !!contentAreaOf && contentAreaOf !== tab;
}

export function readFocusedFieldWith(read: () => FocusedField) {
  readFocusedField = read;
}

export function notePagePressed(windowId: string) {
  const focused = readFocusedField();
  if (focused && (focused.windowId === windowId || !focused.windowId)) pressedOver.set(windowId, focused.field);
}

export function fieldFocusedIn(windowId: string, forTab = ""): boolean {
  const focused = readFocusedField();
  if (!focused || (focused.windowId && focused.windowId !== windowId)) return false;
  if (forTab && focused.contentAreaOf && focused.contentAreaOf !== forTab) return false;
  return pressedOver.get(windowId) !== focused.field;
}

export function noteFieldAsked(windowId: string) {
  if (windowId) pressedOver.delete(windowId);
  else pressedOver.clear();
  for (const listener of [...fieldAskedListeners]) listener();
}

export function placeOfField(field: unknown): FieldPlace {
  let fiber = (field as { __internalInstanceHandle?: Fiber | null } | null)?.__internalInstanceHandle ?? null;
  const place = { windowId: "", contentAreaOf: "" };
  for (let steps = 0; fiber && steps < MOST_ANCESTORS; steps++, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (!props || typeof props !== "object") continue;
    const { windowId, contentAreaOf } = props as { windowId?: unknown; contentAreaOf?: unknown };
    if (typeof windowId === "string" && windowId) place.windowId = windowId;
    if (!place.contentAreaOf && typeof contentAreaOf === "string" && contentAreaOf) place.contentAreaOf = contentAreaOf;
  }
  return place;
}

export const windowIdOfField = (field: unknown) => placeOfField(field).windowId;

export function takeKeyboardFor(native: TakesKeyboard, windowId: string): Promise<boolean> {
  if (!windowId) return Promise.resolve(false);
  return Promise.resolve()
    .then(() => native.takeKeyboardFromPage(windowId))
    .then(
      (moved) => moved === true,
      () => false,
    );
}
