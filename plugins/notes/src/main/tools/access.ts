import type * as Y from "yjs";
import type { Me, WorkspaceInfo } from "../../shared/protocol";

export type NotesAccess = {
  deviceId(): string;
  me(): Me;
  run(op: string, args: unknown): Promise<unknown>;
  has(op: string): boolean;
  workspaces(): WorkspaceInfo[];
  tree(workspace: string): Promise<Y.Doc>;
  doc(workspace: string, page: string): Promise<Y.Doc>;
  edit<T>(workspaces: string[], task: () => Promise<T>): Promise<T>;
  beforeEdit(workspace: string, page: string, doc: Y.Doc): Promise<void>;
  flush(workspace: string, docs: string[]): Promise<boolean>;
  putFile(workspace: string, bytes: Uint8Array, name: string, type: string): Promise<string>;
  openPath(path: string): Promise<void>;
  setting(key: string): unknown;
  storage: { get<T = unknown>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  reindex(): void;
  now(): number;
};
