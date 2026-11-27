import type { PageId } from "../../../shared/protocol";
import type { PageMeta } from "../../../shared/model";
import type { View, ViewResult } from "../../../shared/database";
import type { DatabaseModel } from "../data";
import type { Actions } from "../actions";

export type ViewProps = {
  m: DatabaseModel;
  actions: Actions;
  view: View;
  result: ViewResult;
  inline: boolean;
  editable: boolean;
  openRow: (row: PageId) => void;
  newRow: (input?: { after?: PageId | null; props?: Record<string, unknown>; group?: { prop: string; key: string }; title?: string; open?: boolean }) => Promise<PageId>;
  openPropertyMenu: (prop: string, anchor: HTMLElement) => void;
  openRowMenu: (row: PageMeta, anchor: HTMLElement | { x: number; y: number }) => void;
};
