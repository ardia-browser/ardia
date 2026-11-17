import { create } from "zustand";
import type { NightShadeMode } from "./pageMenu";
import type { PressTarget } from "./pagePrompts";

export type MenuSite = { host: string | null; nightShade: NightShadeMode; blockersEnabled: boolean };

export type MenuTranslation = { languageName: string | null; confirmed: boolean };

export type Press = { tabId: string; target: PressTarget; x: number; y: number };

export type MenuPage = "main" | "siteSettings";

type PageUi = {
  menuOpen: boolean;
  menuPage: MenuPage;
  menuSite: MenuSite | null;
  menuTranslation: MenuTranslation | null;
  titleFeedback: string | null;
  findOpen: boolean;
  findQuery: string;
  readerTabId: string | null;
  press: Press | null;
  zoomLevels: number[];
};

export const usePageUi = create<PageUi>()(() => ({
  menuOpen: false,
  menuPage: "main",
  menuSite: null,
  menuTranslation: null,
  titleFeedback: null,
  findOpen: false,
  findQuery: "",
  readerTabId: null,
  press: null,
  zoomLevels: [],
}));

export const pageUi = () => usePageUi.getState();
