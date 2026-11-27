import { createContext, use } from "react";
import type * as Y from "yjs";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import type { NotesClient } from "../client/types";

export type NotesEnv = {
  client: NotesClient;
  workspace: WorkspaceId;
  page: PageId;
  tree: Y.Doc;
  trees: Map<WorkspaceId, Y.Doc>;
  readOnly: boolean;
  openPage: (page: PageId, options?: { block?: string; newTab?: boolean; workspace?: WorkspaceId }) => void;
  createChildPage: (options?: { kind?: "page" | "database"; title?: string; props?: Record<string, unknown> }) => Promise<PageId>;
  openUrl: (url: string) => void;
};

export const NotesEnvContext = createContext<NotesEnv | null>(null);

export function useNotesEnv(): NotesEnv {
  const env = use(NotesEnvContext);
  if (!env) throw new Error("NotesEnv missing");
  return env;
}

export function useOptionalNotesEnv(): NotesEnv | null {
  return use(NotesEnvContext);
}
