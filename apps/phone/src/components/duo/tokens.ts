import { spring } from "../ui/motion";
import { t } from "../../lib/uiLanguage";


export const duoInk = {
  pageDim: "rgba(0,0,0,0.12)",
  cardShadow: t(`0px 2px 20px rgba(0,0,0,0.12)`),
  sidebarShadow: t(`0px 4px 36px rgba(0,0,0,0.18)`),
} as const;

export const duoMotion = { slide: spring(0.26, 1), reducedFade: 200 } as const;

export const SIDEBAR_GLYPH = {
  frame: t(`M4.5 5.5h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z`),
  divider: t(`M9 5.5v13`),
  rows: t(`M5 9h2M5 11.5h2M5 14h2`),
  stroke: 1.6,
} as const;
