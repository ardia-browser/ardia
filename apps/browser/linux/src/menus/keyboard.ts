import { BrowserWindow, app, shell, type WebContents } from "electron";
import { emit } from "../bridge";
import { confirmWithUser } from "../modules/dialogs";
import { isQuitting, requestQuit } from "../quit";
import { tracing } from "../launch";
import { note } from "../log";
import { appWindow, appWindowIds } from "../windows";
import { Row } from "./commandTable";
import { ESCAPE, LEFT, MODIFIER_ORDER, Modifier, RIGHT, isFunctionKey, isModifierPress, matches, modifierName, modifierOfKey, readKeyPress, recordedKey, type ElectronInput, type KeyPress } from "./keys";
import { menuStore, type CommandEntry } from "./store";

type Recording = (result: { key: string; modifiers: string[] } | null) => void;

const state = {
  escapeCaptured: false,
  switcherCaptured: false,
  textInputFocused: false,
  switcherHeld: 0,
  trackingMenu: false,
  recording: null as Recording | null,
  swallowedKeyUps: new Set<string>(),
  lastCommand: null as { command: string; arg: string | null; windowId: string | null; at: number } | null,
};

export const keyboardState = state;

type PageWindowResolver = (page: WebContents) => BrowserWindow | null | undefined;
let pageWindow: PageWindowResolver = () => null;

export function resolvePageWindowsWith(resolver: PageWindowResolver): void {
  pageWindow = resolver;
}

const outsideAppWindows = new WeakSet<WebContents>();

export function keepOutOfAppWindows(contents: WebContents): void {
  outsideAppWindows.add(contents);
}

function appWindowOrNull(window: BrowserWindow | null | undefined): BrowserWindow | null {
  return window && !window.isDestroyed() && windowIdOf(window) ? window : null;
}

let lastActive: BrowserWindow | null = null;
app.on("browser-window-focus", (_event, window) => {
  if (windowIdOf(window)) lastActive = window;
});

export function activeAppWindow(): BrowserWindow | null {
  const ids = appWindowIds();
  return appWindowOrNull(BrowserWindow.getFocusedWindow()) ?? appWindowOrNull(lastActive) ?? appWindowOrNull(ids.length ? appWindow(ids[ids.length - 1]!) : null);
}

export function windowOf(contents: WebContents): BrowserWindow | null {
  if (outsideAppWindows.has(contents)) return null;
  if (contents.getType() === "webview") {
    const embedder = contents.hostWebContents ? BrowserWindow.fromWebContents(contents.hostWebContents) : null;
    return appWindowOrNull(pageWindow(contents)) ?? appWindowOrNull(embedder) ?? activeAppWindow();
  }
  const own = BrowserWindow.fromWebContents(contents);
  return appWindowOrNull(own) ?? (contents.hostWebContents ? null : activeAppWindow());
}

export function windowIdOf(window: BrowserWindow | null): string | null {
  if (!window) return null;
  for (const id of appWindowIds()) if (appWindow(id) === window) return id;
  return null;
}

export function focusedWindowId(): string | null {
  return windowIdOf(BrowserWindow.getFocusedWindow());
}

export function emitCommand(command: string, arg: string | null, windowId: string | null): void {
  state.lastCommand = { command, arg, windowId, at: Date.now() };
  emit("ArdiaMenus", "onCommand", { command, arg, windowId, focusGeneration: null });
  note("command", `${command}${arg ? `:${arg}` : ""}`);
}

const emitAppEvent = (payload: Record<string, unknown>) => emit("ArdiaShell", "onAppEvent", payload);

export function setEscapeCapture(active: boolean): void {
  state.escapeCaptured = active;
}

export function setSwitcherCapture(active: boolean): void {
  state.switcherCaptured = active;
}

export function setTextInputFocused(focused: boolean): void {
  state.textInputFocused = focused;
}

export function startRecording(): Promise<{ key: string; modifiers: string[] } | null> {
  finishRecording(null);
  return new Promise((resolve) => {
    state.recording = resolve;
  });
}

export function finishRecording(result: { key: string; modifiers: string[] } | null): void {
  const pending = state.recording;
  state.recording = null;
  pending?.(result);
}

function record(press: KeyPress): boolean {
  if (press.fixed === ESCAPE && press.modifiers === 0) {
    finishRecording(null);
    return true;
  }
  const key = recordedKey(press);
  if (!key) return true;
  const held = (press.modifiers & (Modifier.Control | Modifier.Option)) !== 0;
  if (!held && !isFunctionKey(key)) {
    shell.beep();
    return true;
  }
  finishRecording({ key, modifiers: MODIFIER_ORDER.filter((modifier) => press.modifiers & modifier).map(modifierName) });
  return true;
}

function heldModifiersOf(entry: CommandEntry, press: KeyPress): number {
  for (const combo of entry.active) {
    if (!matches(combo, press)) continue;
    const held = combo.modifiers & (Modifier.Control | Modifier.Option | Modifier.Command);
    return held || combo.modifiers & Modifier.Shift;
  }
  return 0;
}

function openedSwitcher(entry: CommandEntry, press: KeyPress): void {
  const held = heldModifiersOf(entry, press);
  state.switcherHeld = held && (press.modifiers & held) === held ? held : 0;
  if (!state.switcherHeld) emitAppEvent({ type: "switcherReleased" });
}

function modifiersChanged(modifiers: number): void {
  if (!state.switcherHeld || (modifiers & state.switcherHeld) === state.switcherHeld) return;
  state.switcherHeld = 0;
  emitAppEvent({ type: "switcherReleased" });
}

function performNative(id: string, window: BrowserWindow | null): boolean {
  if (id === "std:miniaturizeAll:") {
    const ids = appWindowIds();
    for (const windowId of ids) {
      const each = appWindow(windowId);
      if (each?.isVisible()) each.minimize();
    }
    return ids.length > 0;
  }
  if (!window) return false;
  if (id === "std:closeWindow:") window.close();
  else if (id === "std:toggleFullScreen:") window.setFullScreen(!window.isFullScreen());
  else if (id === "std:performMiniaturize:") window.minimize();
  else if (id === "std:performZoom:") window.isMaximized() ? window.unmaximize() : window.maximize();
  else if (id === "std:toggleKeepOnTop:") window.setAlwaysOnTop(!window.isAlwaysOnTop());
  return true;
}

export function dispatch(press: KeyPress, window: BrowserWindow | null): boolean {
  const entry = menuStore.match(press);
  if (!entry) return false;
  if (entry.flags & Row.NativeAction) return performNative(entry.id, window);
  if (!menuStore.entryEnabled(entry)) return false;
  emitCommand(entry.command, entry.arg, windowIdOf(window));
  if (entry.command === "tabSwitcher") openedSwitcher(entry, press);
  return true;
}

function captureSwitcherKey(press: KeyPress, window: BrowserWindow | null): boolean {
  const entry = menuStore.match(press);
  if (entry && entry.command === "tabSwitcher") return dispatch(press, window);
  const key = press.fixed === ESCAPE ? "escape" : press.fixed === RIGHT ? "next" : press.fixed === LEFT ? "previous" : null;
  if (key) emitAppEvent({ type: "switcherKey", key });
  return true;
}

const isQuitPress = (press: KeyPress) => press.fixed === "q" && (press.modifiers === Modifier.Control || press.modifiers === (Modifier.Control | Modifier.Shift));

let askingToQuit = false;

async function quitFromKeyboard(): Promise<void> {
  if (isQuitting() || askingToQuit) return;
  if (!menuStore.warnBeforeQuitting) return requestQuit();
  askingToQuit = true;
  try {
    const answer = await confirmWithUser({ title: "Quit Ardia?", message: "Your windows and tabs open again next time.", confirmTitle: "Quit", cancelTitle: "Cancel", suppression: "Don’t ask again" });
    if (!answer.confirmed) return;
    if (answer.suppressed) emitAppEvent({ type: "quitWarningSuppressed" });
    requestQuit();
  } finally {
    askingToQuit = false;
  }
}

const bareEscape = (press: KeyPress) => press.fixed === ESCAPE && press.modifiers === 0;

function undoReopensClosedTab(press: KeyPress, contents: WebContents, window: BrowserWindow | null): boolean {
  if (press.fixed !== "z" || press.modifiers !== Modifier.Control) return false;
  if (!menuStore.undoReopensClosedTab || menuStore.isDisabled("reopenClosedTab") || !window) return false;
  if (menuStore.match(press)) return false;
  if (state.textInputFocused || contents.getType() === "webview") return false;
  return true;
}

export function handleInput(contents: WebContents, input: ElectronInput): boolean {
  if (input.type === "keyUp") {
    const released = modifierOfKey(input.key);
    if (released) {
      let held = 0;
      if (input.control) held |= Modifier.Control;
      if (input.alt) held |= Modifier.Option;
      if (input.shift) held |= Modifier.Shift;
      modifiersChanged(held & ~released);
    }
    return state.swallowedKeyUps.delete(input.code);
  }
  if (input.type !== "keyDown" && input.type !== "rawKeyDown") return false;
  if (isModifierPress(input.code, input.key) || state.trackingMenu) return false;
  const press = readKeyPress(input);
  if (press.meta || press.altGraph) return false;
  const window = windowOf(contents);
  let handled: boolean;
  if (state.recording) handled = record(press);
  else if (!windowIdOf(window)) return false;
  else if (state.switcherCaptured) handled = captureSwitcherKey(press, window);
  else if (state.escapeCaptured && bareEscape(press)) {
    emitAppEvent({ type: "dragEscape" });
    handled = true;
  } else if (undoReopensClosedTab(press, contents, window)) {
    emitCommand("reopenClosedTab", null, windowIdOf(window));
    handled = true;
  } else handled = dispatch(press, window);
  if (!handled && isQuitPress(press)) {
    void quitFromKeyboard();
    handled = true;
  }
  if (handled) state.swallowedKeyUps.add(input.code);
  return handled;
}

export function watchKeys(contents: WebContents): void {
  contents.on("before-input-event", (event, input) => {
    if (tracing("keys")) note("keys", `${contents.getType()} ${contents.id} host=${contents.hostWebContents?.id ?? "-"} window=${windowIdOf(windowOf(contents))} ${input.type} ${input.key}`);
    if (handleInput(contents, input as ElectronInput)) event.preventDefault();
  });
}

app.on("web-contents-created", (_event, contents) => watchKeys(contents));
