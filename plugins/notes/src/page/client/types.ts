import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { DocId, Me, OpName, Ops, PageId, PresenceEntry, WorkspaceId, WorkspaceInfo } from "../../shared/protocol";

export type Unsubscribe = () => void;

export type OpenDoc = { doc: Y.Doc; awareness: Awareness; synced: Promise<void>; release: () => void };

export interface NotesClient {
  ready: Promise<void>;
  me(): Me;
  onMe(listener: (me: Me) => void): Unsubscribe;
  workspaces(): WorkspaceInfo[];
  onWorkspaces(listener: (list: WorkspaceInfo[]) => void): Unsubscribe;
  presence(): PresenceEntry[];
  onPresence(listener: (list: PresenceEntry[]) => void): Unsubscribe;
  open(workspace: WorkspaceId, doc: DocId): OpenDoc;
  call<K extends OpName>(op: K, args: Ops[K]["args"]): Promise<Ops[K]["value"]>;
  upload(workspace: WorkspaceId, file: Blob, name: string): Promise<string>;
  fileUrl(workspace: WorkspaceId, ref: string): Promise<string>;
  path(): string;
  onPath(listener: (path: string) => void): Unsubscribe;
  navigate(path: string, options?: { replace?: boolean }): void;
  setTitle(title: string): void;
  readonly canExportFiles?: boolean;
  viewing(workspace: WorkspaceId | null, page: PageId | null): void;
  saveState?(): { state: "saved" | "saving" | "unsaved" | "blocked"; refused: number };
  onSaveState?(listener: (state: { state: "saved" | "saving" | "unsaved" | "blocked"; refused: number }) => void): Unsubscribe;
}
