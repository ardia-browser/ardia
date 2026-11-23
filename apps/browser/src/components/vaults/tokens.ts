import { concentric, iconButton, POPOVER_WIDTH, radius, space } from "../ui/tokens";

export const sheetGroupRadius = () => Math.max(radius.control, concentric(radius.sheet, space.xxl));

const CREDENTIAL_ROW = 42;
const FOOTER_ROW = 22;
const ROW_INSET = 7;
const FOOTER_TEXT_INSET = 15;
const VISIBLE_ROWS = 7;

export const VAULT_MENU = {
  gap: space.xs,
  minWidth: POPOVER_WIDTH.s,
  maxWidth: 420,
  row: CREDENTIAL_ROW,
  compactRow: FOOTER_ROW,
  listPad: ROW_INSET,
  separatorGap: space.xs,
  footerBottom: ROW_INSET,
  rowInset: ROW_INSET,
  rowPadding: 10,
  footerPadding: FOOTER_TEXT_INSET - ROW_INSET,
  separatorInset: FOOTER_TEXT_INSET,
  get rowRadius() {
    return concentric(radius.panel, ROW_INSET);
  },
  iconGap: space.l,
  touchID: 24,
  visibleRows: VISIBLE_ROWS,
  maxList: CREDENTIAL_ROW * VISIBLE_ROWS,
  minList: CREDENTIAL_ROW * 2,
  searchHeight: 36,
  icon: { box: 26, glyph: 14, radius: 6 },
  iconEdge: { light: 0.14, dark: 0.22 },
  iconSheen: 0.14,
  spinner: 12,
  textGap: 1,
  badgeAlpha: 0.16,
  glassMaterial: "menu",
  glassTint: 0.35,
  glassVeil: 0.55,
  detailAlpha: 0.72,
  glassSurface: { dark: "#3F3F3F", light: "#DBDBDB" },
} as const;

export const VAULT_TOUCH = {
  shakeMs: 320,
  shakeSteps: [0, 5, -3.6, 2.4, -1.4, 0.6, 0],
  grantMs: 160,
  grantFrom: 0.7,
  grantHoldMs: 260,
  tryAgainMs: 1600,
  crossfadeMs: 150,
  retryDisc: 22,
} as const;

export const VAULT_SAVE = { fieldGap: 6, passwordHeight: 24, usernameWidth: 260 } as const;

export const VAULT_CODE = { ring: 20, stroke: 2.5, expiringMs: 5000, sheetRing: 14, sheetStroke: 1.5, ringGap: space.s, rollMs: 260, rollShift: 9, litWarningContrast: 3, restTrack: { light: 0.25, dark: 0.14 } } as const;

export const VAULT_BADGE = { s: { box: 16, glyph: 9 }, m: { box: 28, glyph: 14 }, l: { box: 36, glyph: 18 }, xl: { box: 52, glyph: 26 } } as const;

export const VAULT_SETTINGS = { paneGround: { light: "#F2F2F2", dark: "#1E1E1E" }, commandMinHeight: 32, commandBorder: 1, spinner: 14, copiedMs: 1500, siteIcon: 20, sourcePopUp: 200, savePopUp: 150 } as const;

const FORM_FIELD = 240;

export const VAULT_FORM = { field: FORM_FIELD, password: FORM_FIELD - 2 * (iconButton.m.box + space.xs), fieldHeight: 24, codeTitle: 200, titleGlyph: 15 } as const;

export const VAULT_SIGN_IN = { ringOutsetX: 6, ringOutsetY: 4, ringRadius: 6, ringWidth: 3, ringAlpha: 0.5, secretInset: 2, tileIcon: 28, tileGlyph: 24, morphMs: 220, stepShift: 14, subtitleWidth: 340, popUpMin: 150, secretHeight: 22 } as const;

export const VAULT_FIELD_BADGE = {
  get radius() {
    return VAULT_MENU.rowRadius;
  },
  glass: {
    fill: { light: "#FFFFFFB8", lightLit: "#FFFFFFE6", dark: "#3F3F3FB8", darkLit: "#4A4A4AE6" },
    edge: { light: "#0000001F", dark: "#FFFFFF24" },
  },
  solid: { tint: { light: { rest: 0.07, lit: 0.12 }, dark: { rest: 0.13, lit: 0.22 } } },
  inkAlpha: { rest: 0.62, lit: 0.88 },
  fadeInMs: 120,
  pressScale: 0.94,
  pressMs: 100,
} as const;

export const VAULT_TILE_BADGE = { size: 11, cut: 1.5, glyph: 7, outset: 3, ardiaZoom: 1.3 } as const;
