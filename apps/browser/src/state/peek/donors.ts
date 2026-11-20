import { create } from "zustand";

export type PeekDonor = { tabId: string; sourceId: string; taken: boolean };

const DONOR_TIMEOUT_MS = 1000;

export const usePeekDonors = create<Record<string, PeekDonor>>()(() => ({}));

const handedOver = new Set<string>();

const windowOf = (tabId: string) => Object.entries(usePeekDonors.getState()).find(([, d]) => d.tabId === tabId)?.[0];

export function releasePeekDonor(windowId: string, tabId: string) {
  const donor = usePeekDonors.getState()[windowId];
  if (!donor || donor.tabId !== tabId) return;
  const next = { ...usePeekDonors.getState() };
  delete next[windowId];
  usePeekDonors.setState(next, true);
}

export function holdPeekDonor(windowId: string, tabId: string, sourceId: string) {
  usePeekDonors.setState({ ...usePeekDonors.getState(), [windowId]: { tabId, sourceId, taken: false } }, true);
  setTimeout(() => releasePeekDonor(windowId, tabId), DONOR_TIMEOUT_MS);
}

export function notePeekRecipient(tabId: string) {
  const windowId = windowOf(tabId);
  if (!windowId) return;
  const donor = usePeekDonors.getState()[windowId]!;
  handedOver.add(tabId);
  usePeekDonors.setState({ ...usePeekDonors.getState(), [windowId]: { ...donor, taken: true } }, true);
  setTimeout(() => releasePeekDonor(windowId, tabId), 0);
}

export const peekDonorTaken = (tabId: string) => handedOver.has(tabId);

export const forgetPeekHandover = (tabId: string) => void handedOver.delete(tabId);
