import { contextBridge, ipcRenderer, webUtils } from "electron";
import "./engine/hostPreload";

type Reply = { value?: unknown; error?: string; code?: string };
type EventListener = (module: string, event: string, payload: unknown) => void;

const unwrap = (module: string, method: string, reply: Reply) => {
  if (reply && typeof reply.error === "string") throw Object.assign(new Error(reply.error), { code: reply.code ?? "ERR_LINUX_NATIVE", module, method });
  return reply?.value;
};

const listeners = new Set<EventListener>();
ipcRenderer.on("ardia:event", (_event, module: string, name: string, payload: unknown) => {
  for (const listener of listeners) listener(module, name, payload);
});

contextBridge.exposeInMainWorld("ardiaLinux", {
  modules: () => ipcRenderer.sendSync("ardia:modules"),
  callSync: (module: string, method: string, args: unknown[]) => unwrap(module, method, ipcRenderer.sendSync("ardia:callSync", module, method, args)),
  call: async (module: string, method: string, args: unknown[]) => unwrap(module, method, await ipcRenderer.invoke("ardia:call", module, method, args)),
  callSyncRaw: (module: string, method: string, args: unknown[]): Reply => ipcRenderer.sendSync("ardia:callSync", module, method, args),
  callRaw: (module: string, method: string, args: unknown[]): Promise<Reply> => ipcRenderer.invoke("ardia:call", module, method, args),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  onEvent: (listener: EventListener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
});
