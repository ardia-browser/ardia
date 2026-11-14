import { ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { acceptsHost, acceptsHostNow } from "./ipcSenders";

type Method = (...args: never[]) => unknown;
export type ModuleSpec = {
  sync?: Record<string, Method>;
  async?: Record<string, Method>;
  constants?: Record<string, unknown>;
};

export type ModuleShape = { sync: string[]; async: string[]; constants?: Record<string, unknown> };

const modules = new Map<string, ModuleSpec>();
const receivers = new Set<WebContents>();

export function defineModule(name: string, spec: ModuleSpec): void {
  const known = modules.get(name);
  modules.set(name, {
    sync: { ...known?.sync, ...spec.sync },
    async: { ...known?.async, ...spec.async },
    constants: { ...known?.constants, ...spec.constants },
  });
}

export function emit(module: string, event: string, payload: unknown): void {
  for (const receiver of receivers) if (!receiver.isDestroyed()) receiver.send("ardia:event", module, event, payload);
}

export function addReceiver(contents: WebContents): void {
  receivers.add(contents);
  contents.once("destroyed", () => receivers.delete(contents));
}

function shapes(): Record<string, ModuleShape> {
  const out: Record<string, ModuleShape> = {};
  for (const [name, spec] of modules)
    out[name] = { sync: Object.keys(spec.sync ?? {}), async: Object.keys(spec.async ?? {}), constants: spec.constants };
  return out;
}

const failure = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error), code: (error as { code?: string })?.code });

const refusal = () => ({ error: "This sender can't use Ardia's native bridge", code: "ERR_LINUX_BRIDGE_SENDER" });

function runSync(module: string, method: string, args: unknown[]) {
  const run = modules.get(module)?.sync?.[method];
  if (!run) return failure(new Error(`${module}.${method} has no sync version on Linux`));
  try {
    return { value: run(...(args as never[])) };
  } catch (error) {
    return failure(error);
  }
}

function answerFromHost(event: IpcMainEvent, channel: string, answer: () => unknown, refused: () => unknown): void {
  if (acceptsHostNow(event)) {
    event.returnValue = answer();
    return;
  }
  void acceptsHost(event, channel).then((accepted) => {
    event.returnValue = accepted ? answer() : refused();
  });
}

export function installBridge(): void {
  ipcMain.on("ardia:modules", (event) => answerFromHost(event, "ardia:modules", shapes, () => ({})));
  ipcMain.on("ardia:callSync", (event, module: string, method: string, args: unknown[]) =>
    answerFromHost(event, "ardia:callSync", () => runSync(module, method, args), refusal),
  );
  ipcMain.handle("ardia:call", async (event, module: string, method: string, args: unknown[]) => {
    if (!(await acceptsHost(event, "ardia:call"))) return refusal();
    const run = modules.get(module)?.async?.[method] ?? modules.get(module)?.sync?.[method];
    if (!run) return failure(new Error(`${module}.${method} is not on Linux`));
    try {
      return { value: await run(...(args as never[])) };
    } catch (error) {
      return failure(error);
    }
  });
}
