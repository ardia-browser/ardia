import { noteFieldAsked, notePagePressed, readFocusedFieldWith, takeKeyboardFor } from "../../../expo-windows/src/appKeyboard";
import { onPagePress } from "../../../expo-windows/src/engine/pages";
import { callMain, mainModules } from "../bridge";
import { lastFocusedAppWindow, onAppWindowAdopted } from "../host/acrossWindows";
import { engineAvailable, hostCall } from "./host";

const TEXT_TYPES = new Set(["", "text", "search", "url", "email", "password", "tel", "number"]);
const MOST_ANCESTORS = 4096;

type Fiber = { return: Fiber | null; memoizedProps?: unknown };

function isTextField(element: Element | null): element is HTMLElement {
  if (!element) return false;
  if (element.nodeName === "TEXTAREA") return true;
  if (element.nodeName === "INPUT") return TEXT_TYPES.has((element as HTMLInputElement).type);
  return (element as HTMLElement).isContentEditable === true;
}

const windowOf = (element: Element) => element.ownerDocument?.documentElement.dataset.ardiaWindow ?? "";

function contentAreaOf(element: Element): string {
  const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  let fiber = key ? ((element as unknown as Record<string, Fiber | undefined>)[key] ?? null) : null;
  for (let steps = 0; fiber && steps < MOST_ANCESTORS; steps++, fiber = fiber.return) {
    const props = fiber.memoizedProps as { contentAreaOf?: unknown } | null | undefined;
    if (props && typeof props === "object" && typeof props.contentAreaOf === "string" && props.contentAreaOf) return props.contentAreaOf;
  }
  return "";
}

function focusedField() {
  const element = lastFocusedAppWindow()?.document.activeElement ?? null;
  if (!isTextField(element)) return null;
  return { field: element, windowId: windowOf(element), contentAreaOf: contentAreaOf(element) };
}

function fieldAskedForKeyboard(event: Event) {
  askForKeyboard(event.target as Element | null);
}

type FocusFollowing = HTMLElement["focus"] & { followsKeyboard?: true };

function followProgrammaticFocus(realm: Window & typeof globalThis) {
  const prototype = realm.HTMLElement.prototype;
  const original = prototype.focus as FocusFollowing;
  if (original.followsKeyboard) return;
  const follows: FocusFollowing = function (this: HTMLElement, options?: FocusOptions) {
    original.call(this, options);
    askForKeyboard(this);
  };
  follows.followsKeyboard = true;
  prototype.focus = follows;
}

function askForKeyboard(target: Element | null) {
  if (!isTextField(target)) return;
  const windowId = windowOf(target);
  noteFieldAsked(windowId);
  if (windowId && engineAvailable()) void hostCall("keyboard.forget", {}, windowId).catch(() => {});
  if (windowId && mainModules().ArdiaFocus?.async.includes("takeKeyboardFromPage")) void takeKeyboardFor(engineFocus, windowId);
}

const engineFocus = { takeKeyboardFromPage: (windowId: string) => callMain<boolean>("ArdiaFocus", "takeKeyboardFromPage", windowId).then((moved) => moved === true) };

let installed = false;

export function installKeyboardFollows() {
  if (installed) return;
  installed = true;
  readFocusedFieldWith(focusedField);
  onPagePress((windowId) => notePagePressed(windowId));
  document.addEventListener("focusin", fieldAskedForKeyboard, true);
  onAppWindowAdopted(followProgrammaticFocus);
}
