import { create } from "zustand";
import { currentPreferences, setPreference } from "../settings/store";
import { offersArchiveCard } from "../tabs/tabModels";

const ARCHIVE_CARD_DELAY_MS = 150;
const DISMISS_AFTER_CHOICE_MS = 600;

export const useArchiveCard = create<{ showing: boolean }>()(() => ({ showing: false }));

let timer: ReturnType<typeof setTimeout> | null = null;

function later(run: () => void, ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    run();
  }, ms);
}

export function offerArchiveCard(openTabs: number): boolean {
  if (!offersArchiveCard(currentPreferences().archiveCardShown, openTabs)) return false;
  later(() => useArchiveCard.setState({ showing: true }), ARCHIVE_CARD_DELAY_MS);
  return true;
}

export function offerArchiveCardNow(openTabs: number) {
  if (!offersArchiveCard(currentPreferences().archiveCardShown, openTabs)) return;
  if (timer) clearTimeout(timer);
  timer = null;
  useArchiveCard.setState({ showing: true });
}

export function showArchiveCardNow() {
  later(() => useArchiveCard.setState({ showing: true }), ARCHIVE_CARD_DELAY_MS);
}

export function hideArchiveCard(): boolean {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!useArchiveCard.getState().showing) return false;
  useArchiveCard.setState({ showing: false });
  return true;
}

export function dismissArchiveCard(): boolean {
  const hid = hideArchiveCard();
  if (hid) setPreference("archiveCardShown", true);
  return hid;
}

export function hideArchiveCardSoon() {
  setPreference("archiveCardShown", true);
  later(() => useArchiveCard.setState({ showing: false }), DISMISS_AFTER_CHOICE_MS);
}

export const useArchiveCardShowing = () => useArchiveCard((s) => s.showing);
