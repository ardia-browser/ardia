import { DECK_HEADER } from "../../lib/deckGeometry";
import { useHeldWhileDeckHidden } from "../../state/browse/deckHold";
import { useTabs } from "../../state/tabs/store";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { screenReaderActions } from "../ui";
import { pageWords } from "../../lib/sharedWords";

export const CARD_MENU_ACTION = "Tab Options";

export const CLOSE_TAB = "Close Tab";

export const TAB_CARD_HINT = "Opens the tab.";

export const UNTITLED_TAB = pageWords.untitledTab;

export const tabCardTitle = (tab: BrowserTab, host: string) => tab.title || host || UNTITLED_TAB;

export const tabCardTitleText = { numberOfLines: 1, maxFontSizeMultiplier: DECK_HEADER.maxFontScale } as const;

export const useIsActiveTab = (id: string) => useHeldWhileDeckHidden(useTabs, (s) => s.selectedId === id);

type TabCardAccessInput = { tab: BrowserTab; title: string; host: string; selected: boolean; open: () => void; close: () => void; menu?: () => void };

export function tabCardAccess({ tab, title, host, selected, open, close, menu }: TabCardAccessInput) {
  return {
    accessible: true,
    accessibilityRole: "button" as const,
    accessibilityLabel: title,
    accessibilityValue: { text: tab.isPrivate ? `Incognito, ${host}` : host },
    accessibilityHint: TAB_CARD_HINT,
    accessibilityState: { selected },
    ...screenReaderActions([{ name: "activate", run: open }, { name: "close", label: CLOSE_TAB, run: close }, ...(menu ? [{ name: "menu", label: CARD_MENU_ACTION, run: menu }] : [])]),
  };
}
