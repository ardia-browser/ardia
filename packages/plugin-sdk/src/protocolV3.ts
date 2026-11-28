export const HOST_METHODS_V3 = {
  surfacePatch: "surface.patch",
  fetchStream: "net.fetch.stream",
  fetchCancel: "net.fetch.cancel",
  wsConnect: "net.ws.connect",
  wsSend: "net.ws.send",
  wsClose: "net.ws.close",
  authSignIn: "auth.signIn",
  servicesProvide: "services.provide",
  servicesWithdraw: "services.withdraw",
  servicesCall: "services.call",
  servicesList: "services.list",
  sidecarSend: "sidecar.send",
  sidecarRequest: "sidecar.request",
  pageReadActive: "page.readActive",
  pageReadTab: "page.readTab",
  pageSendToContent: "page.sendToContent",
  bookmarksList: "bookmarks.list",
  bookmarksSearch: "bookmarks.search",
  bookmarksCreate: "bookmarks.create",
  bookmarksUpdate: "bookmarks.update",
  bookmarksRemove: "bookmarks.remove",
  historySearch: "history.search",
  historyRecent: "history.recent",
  profilesList: "profiles.list",
  profilesCurrent: "profiles.current",
  profilesSwitch: "profiles.switch",
  mediaSessions: "media.sessions",
  mediaControl: "media.control",
  splitsOpen: "splits.open",
  peekOpen: "peek.open",
  clipboardReadText: "clipboard.readText",
  clipboardWriteText: "clipboard.writeText",
  filesPick: "fs.pickFiles",
  filesSave: "fs.saveFile",
  notify: "ui.notify",
} as const;

export const CHANNEL_EVENTS = {
  fetchChunk: "net.fetch.chunk",
  fetchEnd: "net.fetch.end",
  fetchError: "net.fetch.error",
  wsOpen: "net.ws.open",
  wsMessage: "net.ws.message",
  wsClose: "net.ws.close",
  wsError: "net.ws.error",
  sidecarMessage: "sidecar.message",
  contentMessage: "page.contentMessage",
} as const;

export type ChannelEvent = (typeof CHANNEL_EVENTS)[keyof typeof CHANNEL_EVENTS];

export const CHANNEL_EVENT_NAMES: readonly string[] = Object.values(CHANNEL_EVENTS);

export type StreamFetchRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export type StreamHead = { status: number; statusText: string; headers: Record<string, string>; url: string };

export type FetchChunkEvent = { stream: string; data: string };
export type FetchEndEvent = { stream: string };
export type FetchErrorEvent = { stream: string; message: string; code?: string };

export type WsConnectParams = { socket: string; url: string; protocols?: string[]; headers?: Record<string, string> };
export type WsOpenEvent = { socket: string; protocol?: string };
export type WsMessageEvent = { socket: string; data: string; binary?: boolean };
export type WsCloseEvent = { socket: string; code: number; reason: string; wasClean?: boolean };
export type WsErrorEvent = { socket: string; message: string };

export type SignInOptions = {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
  redirect?: "loopback" | "app";
  extraParams?: Record<string, string>;
  prompt?: string;
};

export type SignInResult = {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  idToken?: string;
};

export type ServiceProvider = { plugin: string; version: string; methods: string[] };

export type ServiceCallOptions = { provider?: string; timeoutMs?: number };

export type PageReadOptions = { markdown?: boolean; metadata?: boolean; selection?: boolean; screenshot?: boolean };

export type PageMetadata = {
  description?: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  image?: string;
  lang?: string;
  canonicalUrl?: string;
};

export type PageReadResult = {
  tabId: string;
  url: string;
  title: string;
  text: string;
  markdown?: string;
  metadata?: PageMetadata;
  selection?: string;
  screenshot?: { mimeType: "image/png" | "image/jpeg"; data: string; width: number; height: number };
};

export type ContentMessageEvent = { tabId: string; frameId?: number; scriptId?: string; message: unknown };

export type BookmarkNode = { id: string; parentId: string | null; title: string; url?: string; children?: BookmarkNode[] };
export type BookmarkCreate = { parentId?: string; title: string; url?: string; index?: number };
export type BookmarkUpdate = { title?: string; url?: string; parentId?: string; index?: number };

export type HistoryItem = { url: string; title: string; lastVisitedAt: number; visitCount: number };
export type HistoryQuery = { text?: string; since?: number; until?: number; limit?: number };

export type ProfileInfo = { id: string; name: string; icon?: string; color?: string; current: boolean };

export type MediaSession = { tabId: string; title: string; artist?: string; album?: string; artwork?: string; playing: boolean; muted: boolean; position?: number; duration?: number };
export type MediaAction = "play" | "pause" | "toggle" | "next" | "previous" | "mute" | "unmute" | "seek";

export type SplitOpenOptions = { tabs?: string[]; urls?: string[]; side?: "left" | "right" | "top" | "bottom" };
export type PeekOpenOptions = { url: string };

export type PickFilesOptions = { multiple?: boolean; types?: string[]; title?: string };
export type PickedFile = { name: string; size: number; mimeType: string; data: string; encoding: "base64" | "utf8" };
export type SaveFileOptions = { name: string; data: string; encoding?: "base64" | "utf8"; mimeType?: string };

export type NotifyOptions = { title: string; body?: string; subtitle?: string; icon?: string; command?: string; silent?: boolean };

export type ClipboardText = { text: string };
