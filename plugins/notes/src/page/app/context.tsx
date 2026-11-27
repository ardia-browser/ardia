import { createContext, use } from "react";
import type * as Y from "yjs";
import type { Me, PageId, PageKind, PresenceEntry, WorkspaceId, WorkspaceInfo } from "../../shared/protocol";
import type { NotesClient } from "../client/types";
import type { Route } from "./route";

export type PageRef = { workspace: WorkspaceId; page: PageId };

export type NewPageOptions = { workspace?: WorkspaceId; parent?: PageId | ""; kind?: PageKind; title?: string; icon?: string; after?: PageId; template?: PageId; props?: Record<string, unknown>; open?: boolean; isTemplate?: boolean };

export type AppApi = {
  client: NotesClient;
  me: Me;
  workspaces: WorkspaceInfo[];
  trees: Map<WorkspaceId, Y.Doc>;
  presence: PresenceEntry[];
  route: Route;
  activeWorkspace: WorkspaceId;
  setActiveWorkspace: (id: WorkspaceId) => void;
  workspaceOf: (page: PageId) => WorkspaceId | null;
  treeOf: (workspace: WorkspaceId) => Y.Doc | null;
  openPage: (page: PageId, options?: { workspace?: WorkspaceId; block?: string | null; newTab?: boolean; replace?: boolean; peek?: PageId | null; view?: string | null }) => void;
  navigate: (path: string, options?: { replace?: boolean }) => void;
  newPage: (options?: NewPageOptions) => Promise<PageRef | null>;
  archive: (ref: PageRef) => Promise<void>;
  restore: (ref: PageRef) => Promise<void>;
  deleteForever: (ref: PageRef) => Promise<void>;
  duplicate: (ref: PageRef) => Promise<PageRef | null>;
  move: (ref: PageRef, parent: PageId | "", after?: PageId | null, toWorkspace?: WorkspaceId) => Promise<PageRef | null>;
  favorites: PageRef[];
  isFavorite: (page: PageId) => boolean;
  toggleFavorite: (ref: PageRef) => void;
  recents: PageRef[];
  expanded: Record<string, boolean>;
  setExpanded: (key: string, open: boolean) => void;
  openSearch: (query?: string) => void;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  copyLink: (ref: PageRef) => void;
  moveDialog: (ref: PageRef) => void;
};

export const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const app = use(AppContext);
  if (!app) throw new Error("AppContext missing");
  return app;
}
