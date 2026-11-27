import { useSyncExternalStore } from "react";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import type { GallerySource } from "../../shared/templates/counts";
import type { TemplateCategory } from "../../shared/templates/types";

export type RowTemplateRef = { id: PageId; title: string; icon: string };

export type RowGallery = {
  workspace: WorkspaceId;
  database: PageId;
  title: string;
  templates: RowTemplateRef[];
  useRowTemplate: (template: PageId | null) => Promise<void>;
  openRow: (row: PageId) => void;
};

export type GalleryRequest = {
  source: GallerySource;
  workspace?: WorkspaceId;
  parent?: PageId;
  into?: PageId;
  rows?: RowGallery;
  category?: TemplateCategory | "yours" | "rows";
  template?: string;
};

let current: GalleryRequest | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function openGallery(request: GalleryRequest) {
  current = request;
  emit();
}

export function closeGallery() {
  if (!current) return;
  current = null;
  emit();
}

export function galleryRequest(): GalleryRequest | null {
  return current;
}

export function useGalleryRequest(): GalleryRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
