import { useBrowser } from "../browser/store";

const store = () => useBrowser.getState();
const committedDocuments = new Map<string, { id: number; at: number }>();
let nextDocument = 0;

export function notePageCommit(tabId: string, committedAt: number | undefined) {
  if (typeof committedAt !== "number" || !(committedAt > 0) || !store().tabs[tabId]) return;
  viewlessDocuments.delete(tabId);
  const last = committedDocuments.get(tabId);
  if (last && committedAt === last.at) return;
  committedDocuments.set(tabId, { id: ++nextDocument, at: committedAt });
}

export function notePageEnded(tabId: string) {
  if (!store().tabs[tabId]) return void committedDocuments.delete(tabId);
  const last = committedDocuments.get(tabId);
  committedDocuments.set(tabId, { id: ++nextDocument, at: last?.at ?? 0 });
}

const viewlessDocuments = new Set<string>();
let unwatchViewless: (() => void) | null = null;

function forgetViewlessDocumentsOfClosedTabs() {
  unwatchViewless ??= useBrowser.subscribeTo(["tabs"], (s) => {
    for (const id of viewlessDocuments) {
      if (s.tabs[id]) continue;
      viewlessDocuments.delete(id);
      committedDocuments.delete(id);
    }
    if (viewlessDocuments.size || !unwatchViewless) return;
    unwatchViewless();
    unwatchViewless = null;
  });
}

export function forgetCommittedDocumentIfGone(tabId: string) {
  if (!store().tabs[tabId]) {
    viewlessDocuments.delete(tabId);
    committedDocuments.delete(tabId);
    return;
  }
  if (!committedDocuments.has(tabId)) return;
  viewlessDocuments.add(tabId);
  forgetViewlessDocumentsOfClosedTabs();
}

export const pageDocumentOf = (tabId: string) => committedDocuments.get(tabId)?.id ?? 0;
