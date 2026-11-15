import { MODIFIER_ORDER, Modifier, isFunctionKey, isModifierPress, modifierName, readKeyPress, recordedKey, ESCAPE } from "./combos";
import { menuStore, type CommandEntry } from "./store";
import { callMain, callMainSync, mainModules } from "../../bridge";
import { addNativeListener, emitNativeEvent, type EventSubscription } from "../../events";
import { appWindowDocument } from "../../windows/appWindows";
import { DRAG_ESCAPE, INTERNAL_PREFIX, QUIT, SWITCHER_KEY, buildKeyMap, heldModifiersOf, type KeyMapEntry, type KeyModes } from "./keyMap";

type Recorded = { key: string; modifiers: string[] } | null;
type CommandEvent = { command: string; arg: string | null; windowId: string | null };

const SWITCHER_POLL_MS = 30;
const MOST_LOG_LINES = 40;

const modes: KeyModes = { recording: false, switcherHeld: 0, escapeCaptured: false, textInputFocused: false, undoReopensClosedTab: false, reopenClosedTabEnabled: true };

let recording: ((result: Recorded) => void) | null = null;
let switcherPoll: ReturnType<typeof setInterval> | undefined;
let lastSwitcherHeld: number = Modifier.Control;
let pushed = "";
const recentLog: string[] = [];

export const keyModes = (): Readonly<KeyModes> => modes;

export function noteMenuLog(line: string) {
  recentLog.push(line);
  while (recentLog.length > MOST_LOG_LINES) recentLog.shift();
}

export const recentMenuLog = () => [...recentLog];

const usable = (entry: CommandEntry) => menuStore.entryReachable(entry) && menuStore.entryEnabled(entry);

export function currentKeyMap(): KeyMapEntry[] {
  modes.undoReopensClosedTab = menuStore.undoReopensClosedTab;
  modes.reopenClosedTabEnabled = !menuStore.isDisabled("reopenClosedTab");
  return buildKeyMap(menuStore.entries, usable, modes);
}

export function pushKeyMap(): number | undefined {
  if (!mainModules().ArdiaMenus?.sync.includes("setKeyMap")) return undefined;
  const map = currentKeyMap();
  const text = JSON.stringify(map);
  if (text === pushed) return map.length;
  pushed = text;
  return callMainSync<number>("ArdiaMenus", "setKeyMap", map);
}

const emitAppEvent = (payload: Record<string, unknown>) => emitNativeEvent("ArdiaShell", "onAppEvent", payload);

function finishRecording(result: Recorded) {
  const pending = recording;
  recording = null;
  modes.recording = false;
  document.removeEventListener("keydown", recordPress, true);
  pushKeyMap();
  pending?.(result);
}

function recordPress(event: KeyboardEvent) {
  if (!recording || isModifierPress(event.code, event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const press = readKeyPress({ type: "keyDown", key: event.key, code: event.code, shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey });
  if (press.fixed === ESCAPE && press.modifiers === 0) return finishRecording(null);
  const key = recordedKey(press);
  if (!key) return;
  const held = (press.modifiers & (Modifier.Control | Modifier.Option)) !== 0;
  if (!held && !isFunctionKey(key)) return;
  finishRecording({ key, modifiers: MODIFIER_ORDER.filter((modifier) => press.modifiers & modifier).map(modifierName) });
}

export function recordShortcut(): Promise<Recorded> {
  finishRecording(null);
  return new Promise((resolve) => {
    recording = resolve;
    modes.recording = true;
    document.addEventListener("keydown", recordPress, true);
    pushKeyMap();
  });
}

export const cancelRecording = async () => finishRecording(null);

const heldNow = (): number => {
  const held = callMainSync<number>("ArdiaFocus", "heldModifiers");
  return typeof held === "number" ? held : 0;
};

function stopSwitcherPoll() {
  clearInterval(switcherPoll);
  switcherPoll = undefined;
}

function releaseSwitcher() {
  stopSwitcherPoll();
  if (!modes.switcherHeld) return;
  modes.switcherHeld = 0;
  pushKeyMap();
  emitAppEvent({ type: "switcherReleased" });
}

export function setSwitcherCapture(active: boolean) {
  void callMain("ArdiaFocus", "markSwitcherPointer", !!active);
  stopSwitcherPoll();
  if (!active) {
    modes.switcherHeld = 0;
    pushKeyMap();
    return;
  }
  modes.switcherHeld = lastSwitcherHeld;
  pushKeyMap();
  if (!mainModules().ArdiaFocus?.sync.includes("heldModifiers")) return;
  const watch = () => {
    if ((heldNow() & modes.switcherHeld) !== modes.switcherHeld) releaseSwitcher();
  };
  watch();
  if (modes.switcherHeld) switcherPoll = setInterval(watch, SWITCHER_POLL_MS);
}

export function setDragEscapeCapture(active: boolean) {
  modes.escapeCaptured = !!active;
  pushKeyMap();
}

export function setTextInputFocused(focused: boolean) {
  if (modes.textInputFocused === !!focused) return;
  modes.textInputFocused = !!focused;
  pushKeyMap();
}

export const textInputFocused = () => modes.textInputFocused;

function tabSwitcherHeld(arg: string | null) {
  const entry = menuStore.find(arg ? `tabSwitcher:${arg}` : "tabSwitcher");
  const combo = entry?.active[0];
  lastSwitcherHeld = combo ? heldModifiersOf(combo) || Modifier.Control : Modifier.Control;
}

async function quitFromKeyboard() {
  if (!menuStore.warnBeforeQuitting) return void callMain("ArdiaApp", "quitApp");
  const answer = await callMain<{ confirmed?: boolean; suppressed?: boolean }>("ArdiaDialogs", "confirm", {
    title: "Quit Ardia?",
    message: "Your windows and tabs open again next time.",
    confirmTitle: "Quit",
    cancelTitle: "Cancel",
    suppression: "Don’t ask again",
  }).catch(() => ({ confirmed: true, suppressed: false }));
  if (!answer?.confirmed) return;
  if (answer.suppressed) emitAppEvent({ type: "quitWarningSuppressed" });
  void callMain("ArdiaApp", "quitApp");
}

const ASKS_BEFORE_CLOSING = new Set(["browser", "small"]);

function closeFromKeyboard(windowId: string) {
  const kind = appWindowDocument(windowId)?.documentElement.dataset.ardiaKind ?? "browser";
  if (ASKS_BEFORE_CLOSING.has(kind)) emitNativeEvent("ArdiaAppWindows", "onWindowEvent", { type: "closeRequest", id: windowId });
  else void callMain("ArdiaAppWindows", "closeWindow", windowId);
}

function performNative(id: string, windowId: string | null) {
  if (id === "std:miniaturizeAll:") {
    void callMain<string[]>("ArdiaAppWindows", "windowIds").then((ids) => {
      for (const each of ids ?? []) void callMain("ArdiaAppWindows", "minimizeWindow", each);
    });
    return;
  }
  if (!windowId) return;
  if (id === "std:closeWindow:") closeFromKeyboard(windowId);
  else if (id === "std:performMiniaturize:") void callMain("ArdiaAppWindows", "minimizeWindow", windowId);
  else if (id === "std:performZoom:") void callMain("ArdiaAppWindows", "toggleMaximizeWindow", windowId);
  else if (id === "std:toggleFullScreen:") {
    const state = callMainSync<{ fullScreen?: boolean }>("ArdiaAppWindows", "debugWindowState", windowId);
    void callMain("ArdiaAppWindows", "setPageFullScreen", windowId, !state?.fullScreen);
  }
}

const isInternal = (command: string) => command.startsWith(INTERNAL_PREFIX) || command.startsWith("std:");

function handleInternal({ command, arg, windowId }: CommandEvent) {
  noteMenuLog(`command ${command}${arg ? `:${arg}` : ""}`);
  if (command === "tabSwitcher") return tabSwitcherHeld(arg);
  if (!isInternal(command)) return;
  if (command === SWITCHER_KEY) return emitAppEvent({ type: "switcherKey", key: arg });
  if (command === DRAG_ESCAPE) return emitAppEvent({ type: "dragEscape" });
  if (command === QUIT) return void quitFromKeyboard();
  performNative(command, windowId);
}

export function addMenusListener(event: string, listener: (payload: unknown) => void): EventSubscription {
  if (event !== "onCommand") return addNativeListener("ArdiaMenus", event, listener);
  return addNativeListener("ArdiaMenus", event, (payload) => {
    const command = (payload as CommandEvent | null)?.command ?? "";
    if (!isInternal(command)) listener(payload);
  });
}

let installed = false;

export function installKeys() {
  if (installed) return;
  installed = true;
  addNativeListener("ArdiaMenus", "onCommand", (payload) => handleInternal(payload as CommandEvent));
  pushKeyMap();
}

type DevPress = { key: string; modifiers?: string[]; characters?: string; dry?: boolean };

const DEV_CODES: Record<string, string> = {
  "[": "BracketLeft", "]": "BracketRight", "{": "BracketLeft", "}": "BracketRight", "=": "Equal", "+": "Equal", "-": "Minus", ",": "Comma", ".": "Period",
  "/": "Slash", ";": "Semicolon", "'": "Quote", "\\": "Backslash", "`": "Backquote", " ": "Space", "\t": "Tab", "\r": "Enter", "\u001b": "Escape", "\b": "Backspace",
};

function devInput(press: DevPress) {
  const modifiers = press.modifiers ?? [];
  const code = /^[a-z]$/i.test(press.key)
    ? `Key${press.key.toUpperCase()}`
    : /^\d$/.test(press.key)
      ? `Digit${press.key}`
      : (DEV_CODES[press.key] ?? (/^f\d{1,2}$/i.test(press.key) ? press.key.toUpperCase() : press.key));
  return { type: "keyDown", key: press.characters ?? press.key, code, shift: modifiers.includes("shift"), control: modifiers.includes("control") || modifiers.includes("command"), alt: modifiers.includes("option"), meta: false };
}

export async function devKeyEquivalent(windowId: string, press: DevPress) {
  const entry = menuStore.match(readKeyPress(devInput(press)));
  const matched = entry ? [{ title: entry.title, action: entry.id, command: entry.command, arg: entry.arg ?? undefined, enabled: menuStore.entryEnabled(entry) }] : [];
  if (press.dry || !entry || !menuStore.entryEnabled(entry)) return { handledBy: entry && !press.dry ? "none" : entry ? "menu" : "none", matched, fired: [] };
  if (entry.id.startsWith("std:")) performNative(entry.id, windowId);
  else emitNativeEvent("ArdiaMenus", "onCommand", { command: entry.command, arg: entry.arg, windowId, focusGeneration: null });
  return { handledBy: "menu", matched, fired: [{ title: entry.title, action: entry.id, command: entry.command, arg: entry.arg ?? undefined }] };
}

export const devShortcutRecording = async () => modes.recording;
