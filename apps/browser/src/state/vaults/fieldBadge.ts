import type { VaultField, VaultFieldInset, VaultFieldRect } from "../../platform/vaults";
import { isSecureOrigin } from "./originMatch";

export const BADGE = {
  fallbackInset: 6,
  minInset: 2,
  maxInset: 16,
  minField: 20,
  heightShare: 0.62,
  minHeight: 18,
  maxHeight: 24,
  sidePadShare: 0.22,
  plusGap: 1,
  textRoom: 48,
  pixel: 0.5,
  doubleClickMs: 300,
} as const;

type SymbolMetrics = { width: number; height: number; ink: readonly [number, number, number, number] };
type SymbolSizes = Readonly<Record<number, SymbolMetrics>>;

const SYMBOLS: Readonly<Record<string, SymbolSizes>> = {
  "key.horizontal.fill": {
    8: { width: 12, height: 7, ink: [1, 1.5, 10.5, 6.5] },
    9: { width: 13, height: 8, ink: [1, 1.5, 12, 7] },
    10: { width: 15, height: 9, ink: [1, 1.5, 13, 8] },
    11: { width: 17, height: 10, ink: [1.5, 2, 15, 9] },
  },
  "123.rectangle": {
    8: { width: 12, height: 9, ink: [1, 1, 10, 8.5] },
    9: { width: 13, height: 11, ink: [1, 2, 11.5, 10] },
    10: { width: 14, height: 12, ink: [1, 2, 12.5, 11] },
    11: { width: 16, height: 13, ink: [1.5, 2, 14, 12] },
  },
  "house.fill": {
    8: { width: 12, height: 10, ink: [1, 1, 10.5, 9.5] },
    9: { width: 13, height: 12, ink: [1, 1.5, 11.5, 11] },
    10: { width: 14, height: 13, ink: [1, 1.5, 13, 12] },
    11: { width: 17, height: 14, ink: [1.5, 1.5, 14.5, 13] },
  },
  "creditcard.fill": {
    8: { width: 12, height: 8, ink: [1, 0.5, 10, 7.5] },
    9: { width: 13, height: 10, ink: [1, 1.5, 11.5, 9] },
    10: { width: 14, height: 11, ink: [1, 1.5, 12.5, 10] },
    11: { width: 16, height: 12, ink: [1.5, 1.5, 14, 11] },
  },
  plus: {
    5: { width: 6, height: 6, ink: [0.5, 1.5, 4.5, 5.5] },
    6: { width: 7, height: 7, ink: [0.5, 1.5, 5.5, 6.5] },
    7: { width: 8, height: 7, ink: [1, 0.5, 7, 6.5] },
  },
};

export type BadgeGlyph = { symbol: string; plus: boolean; label: string };

const PASSWORDS: BadgeGlyph = { symbol: "key.horizontal.fill", plus: false, label: "Passwords" };

const GLYPHS: Readonly<Record<string, BadgeGlyph>> = {
  username: PASSWORDS,
  password: PASSWORDS,
  newPassword: { ...PASSWORDS, plus: true },
  otp: { symbol: "123.rectangle", plus: false, label: "Verification Code" },
  address: { symbol: "house.fill", plus: false, label: "Addresses" },
  card: { symbol: "creditcard.fill", plus: false, label: "Cards" },
};

export const badgeGlyphOf = (kind: string | undefined): BadgeGlyph | null => (kind && Object.hasOwn(GLYPHS, kind) ? GLYPHS[kind]! : null);

export type BadgeField = Pick<VaultField, "kind" | "focused" | "main" | "origin" | "rect" | "trailingTaken">;

export function badgeShownFor(field: BadgeField | null, managerConnected: boolean): boolean {
  if (!field?.focused || !field.main || !field.rect || field.trailingTaken) return false;
  return managerConnected && !!badgeGlyphOf(field.kind) && isSecureOrigin(field.origin);
}

export type BadgeArea = { width: number; height: number };
export type BadgeInk = { name: string; size: number; x: number; y: number; width: number; height: number; imageX: number; imageY: number; imageWidth: number; imageHeight: number };
export type BadgeLayout = { width: number; height: number; glyph: BadgeInk; plus: BadgeInk | null; sidePad: number };
export type BadgeFrame = BadgeLayout & { x: number; y: number };

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const snap = (n: number) => Math.round(n / BADGE.pixel) * BADGE.pixel;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const glyphSizeFor = (height: number) => clamp(Math.round(height * 0.45), 8, 11);
const plusSizeFor = (height: number) => (height <= 19 ? 5 : height <= 22 ? 6 : 7);

function inkAt(name: string, size: number, left: number, centerY: number): BadgeInk {
  const m = SYMBOLS[name]![size]!;
  const [l, t, r, b] = m.ink;
  const imageX = snap(left - l);
  const imageY = snap(centerY - (t + b) / 2);
  return { name, size, x: imageX + l, y: imageY + t, width: r - l, height: b - t, imageX, imageY, imageWidth: m.width, imageHeight: m.height };
}

export function badgeLayoutOf(glyph: BadgeGlyph, height: number): BadgeLayout {
  const name = SYMBOLS[glyph.symbol] ? glyph.symbol : "key.horizontal.fill";
  const glyphSize = glyphSizeFor(height);
  const plusSize = plusSizeFor(height);
  const plusInk = glyph.plus ? SYMBOLS.plus![plusSize]!.ink : null;
  const keyInk = SYMBOLS[name]![glyphSize]!.ink;
  const groupWidth = (plusInk ? plusInk[2] - plusInk[0] + BADGE.plusGap : 0) + keyInk[2] - keyInk[0];
  const width = snap(Math.max(height, groupWidth + 2 * Math.round(height * BADGE.sidePadShare)));
  const start = (width - groupWidth) / 2;
  const plus = plusInk ? inkAt("plus", plusSize, start, height / 2) : null;
  const key = inkAt(name, glyphSize, plus ? plus.x + plus.width + BADGE.plusGap : start, height / 2);
  return { width, height, glyph: key, plus, sidePad: (plus ?? key).x };
}

const insetOk = (n: unknown): n is number => finite(n) && n >= 0;

export function badgeFrameOf(glyph: BadgeGlyph, rect: VaultFieldRect | null, zoom: number, area: BadgeArea, rtl: boolean, inset?: VaultFieldInset | null): BadgeFrame | null {
  if (!rect || !finite(zoom) || zoom <= 0 || !finite(area.width) || !finite(area.height)) return null;
  if (![rect.x, rect.y, rect.width, rect.height].every(finite)) return null;
  const left = rect.x * zoom;
  const top = rect.y * zoom;
  const fieldWidth = rect.width * zoom;
  const fieldHeight = rect.height * zoom;
  if (fieldHeight < BADGE.minField || fieldHeight > area.height || fieldWidth > area.width) return null;
  const height = Math.round(clamp(fieldHeight * BADGE.heightShare, BADGE.minHeight, BADGE.maxHeight));
  const layout = badgeLayoutOf(glyph, height);
  const trailing = insetOk(inset?.trailing) && inset.trailing * zoom >= BADGE.minInset && inset.trailing * zoom <= BADGE.maxInset ? inset.trailing * zoom : BADGE.fallbackInset;
  if (fieldWidth < layout.width + 2 * trailing + BADGE.textRoom) return null;
  const contentTop = insetOk(inset?.top) ? inset.top * zoom : 0;
  const contentBottom = insetOk(inset?.bottom) ? inset.bottom * zoom : 0;
  const contentHeight = fieldHeight - contentTop - contentBottom;
  const centerY = contentHeight >= layout.height ? top + contentTop + contentHeight / 2 : top + fieldHeight / 2;
  const x = snap(rtl ? left + trailing : left + fieldWidth - trailing - layout.width);
  const y = snap(centerY - height / 2);
  if (x < 0 || y < 0 || x + layout.width > area.width || y + height > area.height) return null;
  return { ...layout, x, y };
}

export const badgePressCounts = (now: number, lastAt: number) => now - lastAt >= BADGE.doubleClickMs;
