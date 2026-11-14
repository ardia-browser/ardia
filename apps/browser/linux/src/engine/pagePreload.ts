import { contextBridge, ipcRenderer } from "electron";
import pageScript from "../../../../../packages/ardiacore/ios/page_script.js";

type Receive = (kind: string, json: string) => void;
type Ask = (kind: string, message: string, fallback: string | null) => unknown;

const post = (kind: string, json: string) => ipcRenderer.send("ardia:page-script", kind, json);
const ask: Ask = (kind, message, fallback) => ipcRenderer.sendSync("ardia:page-dialog", kind, message, fallback);

function replaceDialogs(ask: Ask) {
  const text = (value: unknown) => (value === undefined ? "" : String(value));
  const replacements: Record<string, (...args: unknown[]) => unknown> = {
    alert(message?: unknown) {
      ask("alert", text(message), null);
    },
    confirm(message?: unknown) {
      return ask("confirm", text(message), null) === true;
    },
    prompt(message?: unknown, fallback?: unknown) {
      const answer = ask("prompt", text(message), fallback === undefined || fallback === null ? "" : String(fallback));
      return typeof answer === "string" ? answer : null;
    },
  };
  for (const [name, replacement] of Object.entries(replacements)) {
    const native = (window as unknown as Record<string, () => unknown>)[name];
    Object.defineProperty(replacement, "name", { value: name });
    Object.defineProperty(replacement, "toString", { value: () => native?.toString() ?? `function ${name}() { [native code] }` });
    Object.defineProperty(window, name, { value: replacement, writable: true, configurable: true, enumerable: true });
  }
}

function steadyGeolocation(settleMs: number) {
  const geolocation = navigator.geolocation;
  if (!geolocation) return;
  const steadied = (success: PositionCallback, failure?: PositionErrorCallback | null): [PositionCallback, PositionErrorCallback] => {
    let held: ReturnType<typeof setTimeout> | undefined;
    return [
      (position) => {
        clearTimeout(held);
        success(position);
      },
      (error) => {
        clearTimeout(held);
        if (error.code === error.POSITION_UNAVAILABLE && !error.message) held = setTimeout(() => failure?.(error), settleMs);
        else failure?.(error);
      },
    ];
  };
  const watch = geolocation.watchPosition;
  const current = geolocation.getCurrentPosition;
  const replacements: Record<string, (...args: never[]) => unknown> = {
    watchPosition(success: PositionCallback, failure?: PositionErrorCallback | null, options?: PositionOptions) {
      return watch.call(geolocation, ...steadied(success, failure), options);
    },
    getCurrentPosition(success: PositionCallback, failure?: PositionErrorCallback | null, options?: PositionOptions) {
      return current.call(geolocation, ...steadied(success, failure), options);
    },
  };
  for (const [name, replacement] of Object.entries(replacements)) {
    const native = (geolocation as unknown as Record<string, () => unknown>)[name];
    Object.defineProperty(replacement, "name", { value: name });
    Object.defineProperty(replacement, "toString", { value: () => native?.toString() ?? `function ${name}() { [native code] }` });
    Object.defineProperty(Object.getPrototypeOf(geolocation), name, { value: replacement, writable: true, configurable: true, enumerable: true });
  }
}

const GEOLOCATION_SETTLE_MS = 250;

if (process.isMainFrame) contextBridge.executeInMainWorld({ func: replaceDialogs, args: [ask] });
if (process.isMainFrame) contextBridge.executeInMainWorld({ func: steadyGeolocation, args: [GEOLOCATION_SETTLE_MS] });

let receive: Receive | undefined;
try {
  receive = contextBridge.executeInMainWorld({ func: pageScript as (post: (kind: string, json: string) => void) => Receive, args: [post] }) as Receive | undefined;
} catch (error) {
  ipcRenderer.send("ardia:page-script", "scriptFailed", JSON.stringify({ message: String((error as Error)?.message ?? error) }));
}

for (const [event, active] of [["enterpictureinpicture", true], ["leavepictureinpicture", false]] as const)
  document.addEventListener(event, () => ipcRenderer.send("ardia:page-picture-in-picture", active), true);

ipcRenderer.on("ardia:page-script", (_event, kind: string, json: string) => {
  if (typeof receive === "function") receive(kind, json);
});
