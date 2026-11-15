import type { BridgeReply, LinuxBridge, ModuleShape } from "../../bridge";

type Listener = (module: string, event: string, payload: unknown) => void;
type Method = (...args: never[]) => unknown;
type FakeModule = { sync?: Record<string, Method>; async?: Record<string, Method>; constants?: Record<string, unknown> };
type HostArgs = Record<string, unknown>;

export type FakeEngineRecord = { verb: string; windowId: string; args: HostArgs; at: number };

export type FakeEngine = {
  calls: FakeEngineRecord[];
  shown: Map<string, HostArgs>;
  shaped: string[];
  windowsShown: string[];
  syncCalls: { module: string; method: string; ms: number }[];
  meadow: string | null;
  emit(module: string, event: string, payload: unknown): void;
  command(command: string, windowId?: string | null): void;
};

const listeners = new Set<Listener>();
const documents = new Map<string, string>(Object.entries((globalThis as { ardiaFakeDocuments?: Record<string, string> }).ardiaFakeDocuments ?? {}));
const record: FakeEngine = {
  calls: [],
  shown: new Map(),
  shaped: [],
  windowsShown: [],
  syncCalls: [],
  meadow: null,
  emit: (module, event, payload) => {
    for (const listener of [...listeners]) listener(module, event, payload);
  },
  command: (command, windowId = null) => record.emit("ArdiaMenus", "onCommand", { command, arg: null, windowId, focusGeneration: null }),
};

const engineEvent = (topic: string, payload: unknown) => setTimeout(() => record.emit("ArdiaEngineHost", "event", { topic, json: JSON.stringify(payload) }), 0);

function navigated(key: string, url: string) {
  const title = url.startsWith("data:") ? "Fixture" : url;
  engineEvent("tab", { key, name: "navigation", data: { url, committedUrl: url, title, isLoading: true, canGoBack: false, canGoForward: false } });
  setTimeout(() => engineEvent("tab", { key, name: "navigation", data: { url, committedUrl: url, title, isLoading: false, canGoBack: false, canGoForward: false } }), 30);
}

function hostCall(verb: string, argsJson: string, windowId: string): string {
  const args = JSON.parse(argsJson) as HostArgs;
  record.calls.push({ verb, windowId, args, at: performance.now() });
  if (verb === "tab.create" && typeof args.key === "string") navigated(args.key, typeof args.url === "string" ? args.url : "");
  if (verb === "tab.show" && typeof args.key === "string") record.shown.set(args.key, args);
  if (verb === "tab.call" && args.method === "loadUrl" && typeof args.key === "string" && typeof args.url === "string") navigated(args.key, args.url);
  if (verb === "tabs.list") return JSON.stringify({ tabs: [] });
  if (verb === "host.info") return JSON.stringify({ engine: "fake" });
  return "{}";
}

const modules: Record<string, FakeModule> = {
  ArdiaApp: {
    constants: { linuxBackend: "chromium", apiVersion: (globalThis as { ardiaFakeApiVersion?: number }).ardiaFakeApiVersion ?? 0 },
    sync: {
      launchConfig: () => ({ dataDirectory: null, configDirectory: "", background: true, isolated: true, testInstance: true, instance: {}, switches: {}, trace: [], test: {} }),
      launchEnvironment: () => null,
    },
    async: { crashReports: async () => [] },
  },
  ArdiaUpdater: { async: { updaterState: async () => ({ available: false, configured: false, automaticChecks: false }) } },
  ArdiaDocuments: {
    sync: {
      readDocument: (name: string) => documents.get(name) ?? null,
      writeDocument: (name: string, contents: string) => void documents.set(name, contents),
    },
    async: {
      saveDocument: async (name: string, contents: string) => void documents.set(name, contents),
      removeDocument: async (name: string) => void documents.delete(name),
    },
  },
  ArdiaAppWindows: {
    constants: { cornerRadius: 12 },
    sync: {
      shapeWindow: (id: string) => void record.shaped.push(id),
      showWindow: (id: string) => void record.windowsShown.push(id),
      isMaximized: () => false,
      windowCornerRadius: () => 12,
    },
    async: {
      focusWindow: async () => {},
      closeWindow: async () => {},
      windowFrame: async () => ({ x: 0, y: 0, width: 1280, height: 800 }),
      frameCornerRadius: async () => 12,
      windowIds: async () => [...new Set(record.shaped)],
      quit: async () => {},
      replyToTerminate: async () => {},
      noteMeadow: async (state: string) => void (record.meadow = state),
    },
  },
  ArdiaEngineHost: {
    sync: { available: () => true },
    async: {
      hostCall: async (verb: string, argsJson: string, windowId: string) => hostCall(verb, argsJson, windowId),
      engineCall: async (name: string) => JSON.stringify({ error: `${name} isn't in the fake engine` }),
    },
  },
  ArdiaMenus: { async: { setKeyMap: async () => {}, showMenu: async () => null } },
};

const shapes = (): Record<string, ModuleShape> =>
  Object.fromEntries(Object.entries(modules).map(([name, spec]) => [name, { sync: Object.keys(spec.sync ?? {}), async: Object.keys(spec.async ?? {}), constants: spec.constants ?? {} }]));

const failure = (error: unknown): BridgeReply => ({ error: error instanceof Error ? error.message : String(error), code: "ERR_LINUX_NATIVE" });

function callSyncRaw(module: string, method: string, args: unknown[]): BridgeReply {
  const run = modules[module]?.sync?.[method];
  if (!run) return failure(`${module}.${method} has no sync version on Linux`);
  const started = performance.now();
  try {
    return { value: JSON.parse(JSON.stringify(run(...(args as never[])) ?? null)) ?? undefined };
  } catch (error) {
    return failure(error);
  } finally {
    record.syncCalls.push({ module, method, ms: performance.now() - started });
  }
}

async function callRaw(module: string, method: string, args: unknown[]): Promise<BridgeReply> {
  const run = modules[module]?.async?.[method] ?? modules[module]?.sync?.[method];
  if (!run) return failure(`${module}.${method} is not on Linux`);
  try {
    return { value: (await run(...(args as never[]))) ?? undefined };
  } catch (error) {
    return failure(error);
  }
}

const unwrap = (module: string, method: string, reply: BridgeReply) => {
  if (typeof reply.error === "string") throw Object.assign(new Error(reply.error), { code: reply.code, module, method });
  return reply.value;
};

export const fakeBridge: LinuxBridge = {
  modules: shapes,
  callSync: (module, method, args) => unwrap(module, method, callSyncRaw(module, method, args)),
  call: async (module, method, args) => unwrap(module, method, await callRaw(module, method, args)),
  callSyncRaw,
  callRaw,
  onEvent: (listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

export function installFakeBridge(target: Window & typeof globalThis) {
  if (target.opener || (target as { ardiaLinux?: unknown }).ardiaLinux) return;
  Object.defineProperty(target, "ardiaLinux", { value: Object.freeze({ ...fakeBridge }) });
  Object.defineProperty(target, "ardiaFakeEngine", { value: record });
}
