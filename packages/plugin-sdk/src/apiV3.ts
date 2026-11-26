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
import { FILE_CHUNK_BYTES } from "./protocolV3";
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

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return out;
}

export function base64OfBytes(bytes: readonly number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64[a >> 2]! + BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]! + (b === undefined ? "=" : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]!) + (c === undefined ? "=" : BASE64[c & 63]!);
  }
  return out;
}

const base64Of = (data: string, encoding: "base64" | "utf8") => (encoding === "base64" ? data : base64OfBytes(utf8Bytes(data)));

export function createArdiaV3(rpc: Rpc, registry: Registry, channels: Channels, state: V3State) {
  async function readFile(handle: string): Promise<string> {
    let data = "";
    let offset = 0;
    try {
      for (;;) {
        const chunk = await rpc.request<{ data: string; eof: boolean }>(M.filesReadChunk, { handle, offset, length: FILE_CHUNK_BYTES });
        if (typeof chunk?.data !== "string") break;
        data += chunk.data;
        offset += Math.floor((chunk.data.length * 3) / 4) - (chunk.data.endsWith("==") ? 2 : chunk.data.endsWith("=") ? 1 : 0);
        if (chunk.eof || !chunk.data) break;
      }
    } finally {
      await rpc.request(M.filesClose, { handle }).then(nothing, nothing);
    }
    return data;
  }

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
      pickFiles: async (options: PickFilesOptions = {}) => {
        const files = listOf<PickedFile>(await rpc.request(M.filesPick, { ...options }), "files");
        for (const file of files) if (file.handle) file.data = await readFile(file.handle);
        return files.map(({ handle: _handle, ...rest }) => rest as PickedFile);
      },
      readFile,
      async saveFile(options: SaveFileOptions): Promise<{ saved: boolean; name?: string }> {
        const encoded = base64Of(options.data, options.encoding ?? "utf8");
        const begun = await rpc.request<{ saved: boolean; handle?: string; name?: string }>(M.filesSaveBegin, { name: options.name, ...(options.mimeType ? { mimeType: options.mimeType } : {}) });
        if (!begun?.saved || !begun.handle) return { saved: false };
        const step = Math.floor(FILE_CHUNK_BYTES / 3) * 4;
        try {
          for (let at = 0; at < encoded.length; at += step) await rpc.request(M.filesSaveChunk, { handle: begun.handle, data: encoded.slice(at, at + step) });
        } catch (error) {
          await rpc.request(M.filesSaveCommit, { handle: begun.handle, commit: false }).then(nothing, nothing);
          throw error;
        }
        return rpc.request<{ saved: boolean; name?: string }>(M.filesSaveCommit, { handle: begun.handle, commit: true });
      },
    },
    notify: (options: NotifyOptions) => rpc.request(M.notify, { ...options }).then(nothing),
    net: {
      fetchStream: channels.fetchStream,
      connect: channels.connect,
    },
  };
}

export type ArdiaV3 = ReturnType<typeof createArdiaV3>;
