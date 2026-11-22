import {
  HOST_METHODS as M,
  type ActivePageSnapshot,
  type ConfirmOptions,
  type FetchRequest,
  type FetchResponseData,
  type InputBoxOptions,
  type PanelResult,
  type PluginTabInfo,
  type PluginWindowInfo,
  type ProgramsStatus,
  type QuickPickItem,
  type QuickPickOptions,
  type ToastOptions,
  type ToolbarUpdate,
  type WorkspaceApplyResult,
  type WorkspaceOp,
  type WorkspaceSnapshotOptions,
} from "./protocol";
import { PluginError, type Rpc } from "./rpc";
import {
  addTo,
  registerIn,
  type CommandHandler,
  type DecideHandler,
  type Disposable,
  type EventListener,
  type OmniboxProvider,
  type PageMessageListener,
  type Registry,
  type SettingsListener,
  type ToolHandler,
  type ViewComponent,
} from "./types";

export type PluginResponse = FetchResponseData & { text(): string; json<T = unknown>(): T };

export type PluginInfo = { name: string; app: string; version: string; protocol: number };

export type ApiState = {
  values: Record<string, unknown>;
  info: PluginInfo;
  subscriptionsChanged(): void;
};

function unwrap(result: unknown, key: string): unknown {
  if (typeof result === "object" && result !== null && !Array.isArray(result) && key in result) return (result as Record<string, unknown>)[key];
  return result;
}

function pickedIds(result: unknown): string[] {
  const picked = unwrap(result, "picked");
  if (typeof picked === "string") return [picked];
  if (Array.isArray(picked)) return picked.filter((id): id is string => typeof id === "string");
  return [];
}

type FetchReply = FetchResponseData | { ok: false; reason?: string };

function response(reply: FetchReply): PluginResponse {
  if (typeof (reply as Partial<FetchResponseData>).status !== "number") {
    const reason = (reply as { reason?: unknown }).reason;
    throw new PluginError("failed", typeof reason === "string" && reason ? reason : "The fetch failed.");
  }
  const data = reply as FetchResponseData;
  return {
    ...data,
    ok: data.status >= 200 && data.status < 300,
    text: () => data.body,
    json: <T>() => JSON.parse(data.body) as T,
  };
}

function quickPick(rpc: Rpc) {
  function pick(items: readonly QuickPickItem[], options: QuickPickOptions & { canPickMany: true }): Promise<QuickPickItem[] | undefined>;
  function pick(items: readonly QuickPickItem[], options?: QuickPickOptions & { canPickMany?: false }): Promise<QuickPickItem | undefined>;
  function pick(items: readonly QuickPickItem[], options: QuickPickOptions): Promise<QuickPickItem | QuickPickItem[] | undefined>;
  async function pick(items: readonly QuickPickItem[], options: QuickPickOptions = {}): Promise<QuickPickItem | QuickPickItem[] | undefined> {
    const sent = { ...options };
    const sentItems = items.map((item) => ({ ...item }));
    const result = await rpc.request(M.quickPick, { items: sentItems, options: sent });
    if (result === null || result === undefined) return undefined;
    const ids = pickedIds(result);
    const chosen = sentItems.filter((item) => ids.includes(item.id));
    return sent.canPickMany ? chosen : chosen[0];
  }
  return pick;
}

export function createArdia(rpc: Rpc, registry: Registry, state: ApiState) {
  const settings = {
    get<T = unknown>(key: string, fallback?: T): T {
      return (key in state.values ? state.values[key] : fallback) as T;
    },
    all: (): Readonly<Record<string, unknown>> => ({ ...state.values }),
    onChange: (listener: SettingsListener): Disposable => addTo(registry.settings, listener),
    async refresh(): Promise<Readonly<Record<string, unknown>>> {
      const values = await rpc.request<Record<string, unknown>>(M.values);
      state.values = { ...(values ?? {}) };
      return { ...state.values };
    },
  };

  const hooks = {
    decide: <D = Record<string, unknown>>(name: string, handler: DecideHandler<D>): Disposable => registerIn(registry.decide, name, handler, "Decide hook"),
    on<D = Record<string, unknown>>(event: string, listener: EventListener<D>): Disposable {
      let listeners = registry.events.get(event);
      if (!listeners) registry.events.set(event, (listeners = new Set()));
      const added = addTo(listeners, listener);
      state.subscriptionsChanged();
      return {
        dispose() {
          added.dispose();
          if (listeners.size === 0 && registry.events.get(event) === listeners) registry.events.delete(event);
          state.subscriptionsChanged();
        },
      };
    },
  };

  const apply = (ops: readonly WorkspaceOp[]) => rpc.request<WorkspaceApplyResult>(M.workspaceApply, { ops });

  const windows = async (): Promise<PluginWindowInfo[]> => {
    const listed = await rpc.request<(Omit<PluginWindowInfo, "tabs"> & { tabs: Omit<PluginTabInfo, "windowId">[] })[]>(M.windows);
    return (listed ?? []).map((w) => ({ ...w, tabs: w.tabs.map((t) => ({ ...t, windowId: w.id })) }));
  };

  return {
    get plugin(): PluginInfo {
      return { ...state.info };
    },
    commands: {
      register: (name: string, handler: CommandHandler): Disposable => registerIn(registry.commands, name, handler, "Command"),
      run: (command: string, options: { arg?: string; windowId?: string; tabId?: string } = {}) =>
        rpc.request(M.run, {
          command,
          ...(options.arg !== undefined ? { arg: options.arg } : {}),
          ...(options.windowId !== undefined ? { window: options.windowId } : {}),
          ...(options.tabId !== undefined ? { tab: options.tabId } : {}),
        }),
    },
    views: {
      register: (viewId: string, component: ViewComponent): Disposable => registerIn(registry.views, viewId, component, "View"),
    },
    omnibox: {
      register: (provider: OmniboxProvider): Disposable => addTo(registry.omnibox, provider),
    },
    tools: {
      register: <I, O>(name: string, handler: ToolHandler<I, O>): Disposable => registerIn(registry.tools, name, handler as ToolHandler, "Tool"),
      call: <T = unknown>(plugin: string, tool: string, input?: unknown) => rpc.request<T>(M.toolsCall, { plugin, tool, input }),
    },
    hooks,
    tabs: {
      windows,
      async query(filter: { active?: boolean; pinned?: boolean; windowId?: string } = {}): Promise<PluginTabInfo[]> {
        const all = (await windows()).flatMap((w) => w.tabs);
        return all.filter(
          (t) =>
            (filter.active === undefined || t.active === filter.active) &&
            (filter.pinned === undefined || t.pinned === filter.pinned) &&
            (filter.windowId === undefined || t.windowId === filter.windowId),
        );
      },
      activePage: async (): Promise<ActivePageSnapshot | null> => (await rpc.request<ActivePageSnapshot | null>(M.activePage)) ?? null,
      open: (urls: string | readonly string[], options: { activate?: boolean } = {}) =>
        rpc.request<{ ok: boolean; tabs: string[] }>(M.open, { urls: typeof urls === "string" ? [urls] : urls, ...options }),
      close: (tabId: string) => apply([{ op: "tab.close", tabs: [tabId] }]),
      activate: (tabId: string) => apply([{ op: "tab.activate", tab: tabId }]),
    },
    workspace: {
      snapshot: <T = Record<string, unknown>>(options: WorkspaceSnapshotOptions = {}) => rpc.request<T>(M.workspace, { ...options }),
      apply,
    },
    ui: {
      quickPick: quickPick(rpc),
      async inputBox(options: InputBoxOptions): Promise<string | undefined> {
        const value = unwrap(await rpc.request(M.inputBox, { options }), "value");
        return typeof value === "string" ? value : undefined;
      },
      async confirm(options: ConfirmOptions): Promise<boolean> {
        return unwrap(await rpc.request(M.confirm, { options }), "confirmed") === true;
      },
      toast: (title: string, message?: string, options: ToastOptions = {}) =>
        rpc.request(M.toast, { title, ...(message ? { message } : {}), options }).then(() => undefined),
    },
    toolbar: {
      update: (itemId: string, update: ToolbarUpdate) => rpc.request(M.toolbarUpdate, { itemId, update }).then(() => undefined),
    },
    panels: {
      open: (panelId: string) => rpc.request<PanelResult>(M.panelOpen, { panelId }),
      close: (panelId: string) => rpc.request<PanelResult>(M.panelClose, { panelId }),
    },
    storage: {
      get: async <T = unknown>(key: string): Promise<T | undefined> => {
        const res = await rpc.request<{ found?: boolean; value?: T }>(M.storageGet, { key });
        return res && typeof res === "object" && res.found === true ? res.value : undefined;
      },
      set: (key: string, value: unknown) => rpc.request(M.storageSet, { key, value }).then(() => undefined),
      delete: (key: string) => rpc.request(M.storageDelete, { key }).then(() => undefined),
      keys: async (): Promise<string[]> => {
        const keys = unwrap(await rpc.request(M.storageKeys), "keys");
        return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
      },
    },
    secrets: {
      get: async (key: string): Promise<string | undefined> => {
        const value = unwrap(await rpc.request(M.secretGet, { key }), "value");
        return typeof value === "string" ? value : undefined;
      },
      set: (key: string, value: string) => rpc.request(M.secretSet, { key, value }).then(() => undefined),
      delete: (key: string) => rpc.request(M.secretDelete, { key }).then(() => undefined),
    },
    settings,
    pages: {
      open: (options: { path?: string; split?: boolean; side?: "left" | "right" | "top" | "bottom"; context?: boolean } = {}) =>
        rpc.request<{ tabId: string; windowId: string }>(M.pageOpen, options),
      post: (view: string, message: unknown) => rpc.request(M.pagePost, { view, message }).then(() => undefined),
      onMessage: (listener: PageMessageListener): Disposable => addTo(registry.pages, listener),
    },
    programs: {
      status: () => rpc.request<ProgramsStatus>(M.programsStatus),
      relink: () => rpc.request<{ ok: boolean }>(M.programsRelink),
    },
    net: {
      async fetch(input: string | FetchRequest, init: Omit<FetchRequest, "url"> = {}): Promise<PluginResponse> {
        const request: FetchRequest = typeof input === "string" ? { ...init, url: input } : { ...input, ...init };
        return response(await rpc.request<FetchReply>(M.fetch, request));
      },
    },
  };
}

export type Ardia = ReturnType<typeof createArdia>;
