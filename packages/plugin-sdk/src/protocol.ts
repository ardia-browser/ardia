export type Tone = "default" | "secondary" | "tertiary" | "accent" | "success" | "warning" | "destructive";

export type Size = "caption" | "small" | "body" | "heading" | "title";

export type Space = "none" | "xxs" | "xs" | "s" | "m" | "l" | "xl";

export type PluginNodeType =
  | "Fragment"
  | "Box"
  | "Text"
  | "Markdown"
  | "Badge"
  | "Button"
  | "Divider"
  | "EmptyState"
  | "Progress"
  | "List"
  | "ListSection"
  | "ListItem"
  | "Detail"
  | "Form"
  | "TextField"
  | "PasswordField"
  | "Toggle"
  | "Select"
  | "SidebarView"
  | "SidebarSection"
  | "SidebarItem"
  | "Popover"
  | "ActionPanel"
  | "Action"
  | "WebView";

export const PLUGIN_NODE_TYPES: readonly PluginNodeType[] = [
  "Fragment",
  "Box",
  "Text",
  "Markdown",
  "Badge",
  "Button",
  "Divider",
  "EmptyState",
  "Progress",
  "List",
  "ListSection",
  "ListItem",
  "Detail",
  "Form",
  "TextField",
  "PasswordField",
  "Toggle",
  "Select",
  "SidebarView",
  "SidebarSection",
  "SidebarItem",
  "Popover",
  "ActionPanel",
  "Action",
  "WebView",
];

export type SerializedHandler = { __handler: string };

export type PluginNode = {
  type: PluginNodeType;
  key?: string | number;
  props: Record<string, unknown>;
  children: (PluginNode | string)[];
};

export type SurfaceKind = "sidebar" | "popover" | "panel" | "command";

export type SurfaceMountMessage = {
  surface: "mount";
  surfaceId: string;
  viewId: string;
  kind: SurfaceKind;
  context?: Record<string, unknown>;
};

export type SurfaceUnmountMessage = { surface: "unmount"; surfaceId: string };

export type SurfaceEventMessage = { surface: "event"; surfaceId: string; handlerId: string; args: unknown[] };

export type SurfaceMessage = SurfaceMountMessage | SurfaceUnmountMessage | SurfaceEventMessage;

export type SurfaceRenderParams = { surfaceId: string; tree: PluginNode };

export type QuickPickItem = {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  badge?: string;
  keywords?: string[];
  picked?: boolean;
};

export type QuickPickOptions = { title?: string; placeholder?: string; canPickMany?: boolean };

export type InputBoxOptions = {
  title: string;
  message?: string;
  placeholder?: string;
  value?: string;
  password?: boolean;
  confirmTitle?: string;
};

export type ConfirmOptions = { title: string; message?: string; confirmTitle?: string; destructive?: boolean };

export type ToastOptions = { icon?: string; tone?: Tone };

export type ToolbarUpdate = {
  icon?: string;
  label?: string | null;
  badge?: string | number | boolean | null;
  tooltip?: string | null;
  tone?: Tone;
};

export type OmniboxSuggestion = { title: string; url: string; subtitle?: string; icon?: string; badge?: string };

export type ActivePageSnapshot = { tabId: string; url: string; title: string; text: string; selection: string; lang: string };

export type WorkspaceSnapshotOptions = { window?: string | null; profile?: string | null; usage?: boolean };

export type WorkspaceOp = Record<string, unknown> & { op: string };

export type WorkspaceApplyResult = { ok: boolean; results?: unknown[] };

export const STATE_TOPICS = ["tabs", "workspace", "navigation", "downloads"] as const;

export type StateTopic = (typeof STATE_TOPICS)[number];

export type StateTab = { id: string; windowId: string; index: number; url: string | null; title: string | null; pinned: boolean; active: boolean; groupId: string | null; muted: boolean };

export type StateWindow = { id: string; kind: "normal" | "little"; focused: boolean; activeTabId: string | null; tabCount: number };

export type StateGroup = { id: string; windowId: string; name: string; color: string; icon: string | null; collapsed: boolean; pinned: boolean; parentId: string | null; tabIds: string[]; tabIdsPage?: { index: number; count: number } };

export type StateDownload = { id: string; state: "downloading" | "finished" | "failed" | "cancelled"; paused: boolean; dangerous: boolean; received: number; total: number; mimeType: string; filename: string; url: string | null };

export type TabsChange = { initial?: true; more?: true; tabs: StateTab[]; removed: string[] };

export type WorkspaceChange = { initial?: true; more?: true; windows: StateWindow[]; groups: StateGroup[]; removedWindows: string[]; removedGroups: string[] };

export type NavigationCommit = { tabId: string; windowId: string; url: string; title: string | null; sameDocument: boolean };

export type NavigationChange = { more?: true; commits: NavigationCommit[] };

export type DownloadsChange = { initial?: true; more?: true; downloads: StateDownload[]; removed: string[] };

export type StateEventMap = { tabs: TabsChange; workspace: WorkspaceChange; navigation: NavigationChange; downloads: DownloadsChange };

export type GroupColorName = "neutral" | "none" | "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export type GroupLook = { name?: string; color?: GroupColorName; icon?: string | null; collapsed?: boolean };

export type StateIntentArgs = {
  "tabs.group": { tabs: string[] } & GroupLook;
  "tabs.ungroup": { group: string };
  "tabs.move": { tabs: string[]; before?: string; after?: string; group?: string | null; window?: string };
  "tabs.pin": { tabs: string[]; as?: "tile" | "row" };
  "tabs.unpin": { tabs: string[] };
  "tabs.mute": { tabs: string[] };
  "tabs.unmute": { tabs: string[] };
  "tabs.activate": { tab: string };
  "groups.update": { group: string } & GroupLook;
};

export type StateIntent = keyof StateIntentArgs;

export type StateIntentResult = { ok: true; group?: string };

export type PanelResult = { ok: boolean; windowId: string; tabId?: string };

export type FetchRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export type FetchResponseData = {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type PluginTabInfo = {
  id: string;
  windowId: string;
  url: string;
  title: string;
  profile: string;
  active: boolean;
  pinned: boolean;
  group: string | null;
};

export type PluginWindowInfo = {
  id: string;
  kind: "normal" | "little";
  focused: boolean;
  profile: string;
  profileName: string;
  tabs: PluginTabInfo[];
};

export type CallKind = "tool" | "command" | "omnibox" | "decide";

export type PluginCallMessage = {
  call: string;
  kind?: CallKind;
  name?: string;
  tool?: string;
  input?: unknown;
  context?: Record<string, unknown>;
  caller?: unknown;
  deadline?: number;
  command?: string;
  provider?: string;
  query?: string;
  event?: string;
  data?: Record<string, unknown>;
};

export type PluginCancelMessage = { call: string; cancel: true };

export type PluginEventMessage = { event: string; time?: number; data?: Record<string, unknown> };

export type PageMessageEnvelope = { pageMessage: unknown; view: string };

export type HostReply = { id: string | number | null; result?: unknown; error?: { code?: string; message?: string } | string };

export type HelloResult = { app: string; version: string; protocol: number; plugin: string; values?: Record<string, unknown> };

export type ReadyParams = {
  commands: string[];
  tools: string[];
  views: string[];
  omnibox: boolean;
  decide: string[];
  events: string[];
};

export const PLUGIN_PROTOCOL = 2;

export type ProgramsStatus = { state: "none" | "linking" | "linked" | "failed"; linked: string[]; failed: { name: string; reason: string }[]; binDir: string | null };

export const HOST_METHODS = {
  hello: "hello",
  ready: "ready",
  result: "result",
  values: "values",
  subscribe: "subscribe",
  windows: "windows",
  run: "run",
  open: "open",
  toolsCall: "tools.call",
  activePage: "tabs.readActivePage",
  workspace: "workspace",
  workspaceApply: "apply",
  quickPick: "ui.showQuickPick",
  inputBox: "ui.showInputBox",
  confirm: "ui.showConfirm",
  toast: "ui.showToast",
  toolbarUpdate: "toolbar.update",
  panelOpen: "panel.open",
  panelClose: "panel.close",
  storageGet: "storage.get",
  storageSet: "storage.set",
  storageDelete: "storage.delete",
  storageKeys: "storage.keys",
  secretGet: "secrets.get",
  secretSet: "secrets.set",
  secretDelete: "secrets.delete",
  pageOpen: "page.open",
  pagePost: "page.post",
  fetch: "net.fetch",
  programsStatus: "programs.status",
  programsRelink: "programs.relink",
  stateSubscribe: "state.subscribe",
  stateIntent: "state.intent",
  surfaceRender: "surface.render",
  surfaceClose: "surface.close",
} as const;

export type HostMethod = (typeof HOST_METHODS)[keyof typeof HOST_METHODS];

export function isHandlerRef(value: unknown): value is SerializedHandler {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { __handler?: unknown }).__handler === "string" &&
    Object.keys(value).length === 1
  );
}

export function isSurfaceMessage(value: unknown): value is SurfaceMessage {
  if (typeof value !== "object" || value === null) return false;
  const surface = (value as { surface?: unknown }).surface;
  return (surface === "mount" || surface === "unmount" || surface === "event") && typeof (value as { surfaceId?: unknown }).surfaceId === "string";
}
