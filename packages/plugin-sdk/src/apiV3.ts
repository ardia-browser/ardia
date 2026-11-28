import type { Channels } from "./channels";
import {
  HOST_METHODS_V3 as M,
  type BookmarkCreate,
  type BookmarkNode,
  type BookmarkUpdate,
  type ClipboardText,
  type ContentMessageEvent,
  type HistoryItem,
  type HistoryQuery,
  type MediaAction,
  type MediaSession,
  type NotifyOptions,
  type PageReadOptions,
  type PageReadResult,
  type PeekOpenOptions,
  type PickedFile,
  type PickFilesOptions,
  type ProfileInfo,
  type SaveFileOptions,
  type ServiceCallOptions,
  type ServiceProvider,
  type SignInOptions,
  type SignInResult,
  type SplitOpenOptions,
} from "./protocol";
import { PluginError, type Rpc } from "./rpc";
import { disposable, type Disposable, type Registry, type ServiceHandlers } from "./types";

const INTERFACE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const METHOD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type V3State = { isReady(): boolean; report(error: unknown): void };

const listOf = <T>(value: unknown, key: string): T[] => {
  if (Array.isArray(value)) return value as T[];
  const inner = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return Array.isArray(inner) ? (inner as T[]) : [];
};

const nothing = () => undefined;

function checkInterface(iface: string) {
  if (!INTERFACE.test(iface)) throw new PluginError("bad-interface", `${iface} isn't an interface name like ai.provider.`);
}

function httpsOnly(url: string, label: string) {
  if (!/^https:\/\/[^\s/]+/.test(url) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(url)) throw new PluginError("bad-url", `${label} must be an https:// URL.`);
}

export function createArdiaV3(rpc: Rpc, registry: Registry, channels: Channels, state: V3State) {
  const services = {
    provide(iface: string, handlers: ServiceHandlers): Disposable {
      checkInterface(iface);
      if (registry.services.has(iface)) throw new Error(`Service ${iface} is already provided.`);
      const methods = Object.keys(handlers);
      for (const method of methods) {
        if (!METHOD.test(method) || typeof handlers[method] !== "function") throw new PluginError("bad-method", `${iface}.${method} must be a function named with letters, digits and _.`);
      }
      const table = { ...handlers };
      registry.services.set(iface, table);
      if (state.isReady()) rpc.request(M.servicesProvide, { iface, methods }).then(nothing, state.report);
      return disposable(() => {
        if (registry.services.get(iface) !== table) return;
        registry.services.delete(iface);
        if (state.isReady()) rpc.request(M.servicesWithdraw, { iface }).then(nothing, state.report);
      });
    },
    call<T = unknown>(iface: string, method: string, input?: unknown, options: ServiceCallOptions = {}): Promise<T> {
      checkInterface(iface);
      return rpc.request<T>(M.servicesCall, { iface, method, input: input ?? null, ...options });
    },
    async list(iface: string): Promise<ServiceProvider[]> {
      checkInterface(iface);
      return listOf<ServiceProvider>(await rpc.request(M.servicesList, { iface }), "providers");
    },
  };

  const page = {
    readActive: (options: PageReadOptions = {}) => rpc.request<PageReadResult | null>(M.pageReadActive, { ...options }).then((r) => r ?? null),
    readTab: (tabId: string, options: PageReadOptions = {}) => rpc.request<PageReadResult | null>(M.pageReadTab, { tabId, ...options }).then((r) => r ?? null),
    sendToContent: (tabId: string, message: unknown, options: { scriptId?: string; frameId?: number } = {}) =>
      rpc.request(M.pageSendToContent, { tabId, message, ...options }).then(nothing),
    onContentMessage: (listener: (event: ContentMessageEvent) => void): Disposable => channels.onContentMessage(listener),
  };

  return {
    services,
    page,
    sidecar: {
      send: (message: unknown) => rpc.request(M.sidecarSend, { message }).then(nothing),
      request: <T = unknown>(method: string, params?: unknown) => rpc.request<T>(M.sidecarRequest, { method, params: params ?? null }),
      onMessage: (listener: (message: unknown) => void): Disposable => channels.onSidecarMessage(listener),
    },
    auth: {
      signIn(options: SignInOptions): Promise<SignInResult> {
        httpsOnly(options.authorizeUrl, "authorizeUrl");
        httpsOnly(options.tokenUrl, "tokenUrl");
        if (!options.clientId) return Promise.reject(new PluginError("bad-args", "signIn needs a clientId."));
        return rpc.request<SignInResult>(M.authSignIn, { ...options, pkce: "S256" });
      },
    },
    bookmarks: {
      list: async (parentId?: string) => listOf<BookmarkNode>(await rpc.request(M.bookmarksList, parentId ? { parentId } : {}), "bookmarks"),
      search: async (query: string, limit = 50) => listOf<BookmarkNode>(await rpc.request(M.bookmarksSearch, { query, limit }), "bookmarks"),
      create: (bookmark: BookmarkCreate) => rpc.request<BookmarkNode>(M.bookmarksCreate, { ...bookmark }),
      update: (id: string, changes: BookmarkUpdate) => rpc.request<BookmarkNode>(M.bookmarksUpdate, { id, ...changes }),
      remove: (id: string) => rpc.request(M.bookmarksRemove, { id }).then(nothing),
    },
    history: {
      search: async (query: HistoryQuery = {}) => listOf<HistoryItem>(await rpc.request(M.historySearch, { ...query }), "items"),
      recent: async (limit = 20) => listOf<HistoryItem>(await rpc.request(M.historyRecent, { limit }), "items"),
    },
    profiles: {
      list: async () => listOf<ProfileInfo>(await rpc.request(M.profilesList), "profiles"),
      current: () => rpc.request<ProfileInfo>(M.profilesCurrent),
      switch: (profileId: string) => rpc.request(M.profilesSwitch, { profile: profileId }).then(nothing),
    },
    media: {
      sessions: async () => listOf<MediaSession>(await rpc.request(M.mediaSessions), "sessions"),
      control: (tabId: string, action: MediaAction, value?: number) => rpc.request(M.mediaControl, { tabId, action, ...(value !== undefined ? { value } : {}) }).then(nothing),
    },
    splits: {
      open: (options: SplitOpenOptions) => rpc.request<{ ok: boolean; tabs?: string[] }>(M.splitsOpen, { ...options }),
    },
    peek: {
      open: (url: string | PeekOpenOptions) => rpc.request<{ ok: boolean }>(M.peekOpen, typeof url === "string" ? { url } : { ...url }),
    },
    clipboard: {
      readText: async () => {
        const reply = await rpc.request<ClipboardText | string | null>(M.clipboardReadText);
        return typeof reply === "string" ? reply : (reply?.text ?? "");
      },
      writeText: (text: string) => rpc.request(M.clipboardWriteText, { text }).then(nothing),
    },
    fs: {
      pickFiles: async (options: PickFilesOptions = {}) => listOf<PickedFile>(await rpc.request(M.filesPick, { ...options }), "files"),
      saveFile: (options: SaveFileOptions) => rpc.request<{ saved: boolean; name?: string }>(M.filesSave, { encoding: "utf8", ...options }),
    },
    notify: (options: NotifyOptions) => rpc.request(M.notify, { ...options }).then(nothing),
    net: {
      fetchStream: channels.fetchStream,
      connect: channels.connect,
    },
  };
}

export type ArdiaV3 = ReturnType<typeof createArdiaV3>;
