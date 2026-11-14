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

if (process.isMainFrame) contextBridge.executeInMainWorld({ func: replaceDialogs, args: [ask] });

let receive: Receive | undefined;
try {
  receive = contextBridge.executeInMainWorld({ func: pageScript as (post: (kind: string, json: string) => void) => Receive, args: [post] }) as Receive | undefined;
} catch (error) {
  ipcRenderer.send("ardia:page-script", "scriptFailed", JSON.stringify({ message: String((error as Error)?.message ?? error) }));
}

ipcRenderer.on("ardia:page-script", (_event, kind: string, json: string) => {
  if (typeof receive === "function") receive(kind, json);
});
