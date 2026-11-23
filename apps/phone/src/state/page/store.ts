import { create } from "zustand";
import type { NightShadeMode } from "./pageMenu";
import type { PressTarget } from "./pagePrompts";

export type MenuSite = { host: string | null; isPrivate: boolean; nightShade: NightShadeMode; blockersEnabled: boolean };

export type TranslationAsk = { opening: number; tabId: string; url: string };

export type MenuTranslation = { languageName: string | null; confirmed: boolean };

export type Press = { tabId: string; target: PressTarget; x: number; y: number };

export type MenuPage = "main" | "siteSettings" | "library";

type PageUi = {
  menuOpen: boolean;
  menuOpening: number;
  menuPage: MenuPage;
  menuDocked: boolean;
  menuSite: MenuSite | null;
  menuTranslation: MenuTranslation | null;
  translationAsk: TranslationAsk | null;
  titleFeedback: string | null;
  findOpen: boolean;
  findIsPrivate: boolean;
  findQuery: string;
  readerTabId: string | null;
  press: Press | null;
  zoomLevels: number[];
};

export const usePageUi = create<PageUi>()(() => ({
  menuOpen: false,
  menuOpening: 0,
  menuPage: "main",
  menuDocked: false,
  menuSite: null,
  menuTranslation: null,
  translationAsk: null,
  titleFeedback: null,
  findOpen: false,
  findIsPrivate: true,
  findQuery: "",
  readerTabId: null,
  press: null,
  zoomLevels: [],
}));

export const pageUi = () => usePageUi.getState();
