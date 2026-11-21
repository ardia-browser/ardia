import { create } from "zustand";
import { pageBarsWanted } from "./pageBarGate";
import { consumeTypedAddress } from "./siteSwitches";
import { dropTypedAddress } from "./typedAddresses";

export const DOCUMENT_SETTLE_MS = 300;

export type PageDocument = { url: string; at: number; agrees: boolean; settled: boolean };

export const usePageDocuments = create<Record<string, PageDocument>>()(() => ({}));

export type DocumentReporter = object;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const reporters = new Map<string, DocumentReporter>();

function cancelTimer(tabId: string) {
  const timer = timers.get(tabId);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(tabId);
}

const patch = (tabId: string, doc: PageDocument | null) =>
  usePageDocuments.setState((s) => {
    const next = { ...s };
    if (doc) next[tabId] = doc;
    else delete next[tabId];
    return next;
  }, true);

function settleLater(tabId: string, at: number, wait: number) {
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId);
      const now = usePageDocuments.getState()[tabId];
      if (now && now.at === at && !now.settled) patch(tabId, { ...now, settled: true });
    }, wait),
  );
}

function drop(tabId: string) {
  cancelTimer(tabId);
  if (Object.hasOwn(usePageDocuments.getState(), tabId)) patch(tabId, null);
}

export function notePageDocument(tabId: string, shownUrl: string, committedUrl: string | undefined, committedAt: number | undefined, privatePage: boolean, reporter: DocumentReporter, now = Date.now()) {
  reporters.set(tabId, reporter);
  if (!pageBarsWanted()) return;
  if (committedUrl === undefined) return drop(tabId);
  const before = Object.hasOwn(usePageDocuments.getState(), tabId) ? usePageDocuments.getState()[tabId] : undefined;
  const at = typeof committedAt === "number" && committedAt > 0 ? committedAt : 0;
  const agrees = committedUrl !== "" && committedUrl === shownUrl;
  const sameDocument = before && (at > 0 ? at === before.at : before.at === 0 && committedUrl === before.url);
  if (sameDocument) {
    if (before.url !== committedUrl) dropTypedAddress(tabId);
    if (before.url !== committedUrl || before.agrees !== agrees) patch(tabId, { ...before, url: committedUrl, agrees });
    return;
  }
  cancelTimer(tabId);
  if (committedUrl) consumeTypedAddress(tabId, committedUrl, at, privatePage);
  const wait = at > 0 ? at + DOCUMENT_SETTLE_MS - now : DOCUMENT_SETTLE_MS;
  const settled = wait <= 0;
  patch(tabId, { url: committedUrl, at, agrees, settled });
  if (!settled) settleLater(tabId, at, Math.min(wait, DOCUMENT_SETTLE_MS));
}

export function forgetAllPageDocuments() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (Object.keys(usePageDocuments.getState()).length) usePageDocuments.setState({}, true);
}

export function forgetPageDocument(tabId: string, reporter: DocumentReporter) {
  if (reporters.has(tabId) && reporters.get(tabId) !== reporter) return;
  reporters.delete(tabId);
  drop(tabId);
}

export const confirmedDocument = (docs: Record<string, PageDocument>, tabId: string): PageDocument | null => {
  const doc = Object.hasOwn(docs, tabId) ? docs[tabId]! : null;
  return doc && doc.settled && doc.agrees && doc.url ? doc : null;
};
