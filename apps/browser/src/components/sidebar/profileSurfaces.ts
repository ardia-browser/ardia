import { hex, type Theme } from "../ui/theme";
import { colorDistance, luminance, over, parseColor, toHex } from "../../lib/color";
import { fromOklab, oklab } from "../../lib/profileLook";
import { ink } from "../ui/tokens";

type Lab = [number, number, number];

type PaneTones = { rest: string; hover: string; pressed: string; selected: string };

type ProfileSurfaces = {
  sidebar: string;
  selectedRow: string;
  ghost: string;
  ghostText: string;
  activePanes: PaneTones;
  idlePanes: PaneTones;
  emptySlot: string;
};

const PANE_STEPS = {
  dark: { rest: 0.06, hover: 0.09, pressed: 0.12, selected: 0.14 },
  light: { rest: -0.04, hover: -0.06, pressed: -0.08, selected: 0.05 },
} as const;

const GHOST_STEP = { deeper: 0.07, lighter: 0.015 } as const;
const ACCENT_SHARE = 0.32;
const ACCENT_MIN_CHROMA = 0.02;
const PANE_CHROMA_MAX = 0.07;
const PANE_CHROMA_PER_LIGHTNESS = 0.3;
export const MIN_PANE_TEXT_CONTRAST = 4.5;

const labOf = (color: string): Lab => {
  const [r, g, b] = parseColor(color);
  return oklab({ r: r / 255, g: g / 255, b: b / 255, a: 1 });
};

const inGamut = (lab: Lab) => fromOklab(lab).every((v) => v >= -1e-4 && v <= 1 + 1e-4);

const hexOf = (lab: Lab) => toHex(fromOklab(lab).map((v) => Math.min(1, Math.max(0, v)) * 255));

export function toneStep(surface: string, accent: string, lightness: number): string {
  const [l, a, b] = labOf(surface);
  const [, pa, pb] = labOf(accent);
  const accentChroma = Math.hypot(pa, pb);
  const target = Math.min(1, Math.max(0, l + lightness));
  const own = Math.hypot(a, b);
  const tinted = accentChroma >= ACCENT_MIN_CHROMA;
  const wanted = tinted ? Math.min(PANE_CHROMA_MAX, target * PANE_CHROMA_PER_LIGHTNESS, Math.max(own, accentChroma * ACCENT_SHARE)) : own;
  const [ua, ub] = tinted ? [pa / accentChroma, pb / accentChroma] : own > 1e-6 ? [a / own, b / own] : [0, 0];
  const at = (chroma: number): Lab => [target, ua * chroma, ub * chroma];
  if (inGamut(at(wanted))) return hexOf(at(wanted));
  let [inside, outside] = [0, wanted];
  for (let i = 0; i < 16; i++) {
    const mid = (inside + outside) / 2;
    if (inGamut(at(mid))) inside = mid;
    else outside = mid;
  }
  return hexOf(at(inside));
}

const lightInk = (text: string) => contrastRatio(text, ink.black) > contrastRatio(text, ink.white);

const MIN_SHOWN_PANE_DISTANCE = 0.04;

function shownPane(surface: string, accent: string, step: number, ink: string, rest: string): string {
  const candidates = [step, -step, -2.2 * step].map((s) => toneStep(surface, accent, s));
  const fits = (fill: string) => contrastRatio(ink, fill) >= MIN_PANE_TEXT_CONTRAST && colorDistance(fill, rest) >= MIN_SHOWN_PANE_DISTANCE;
  return candidates.find(fits) ?? candidates.reduce((best, fill) => (contrastRatio(ink, fill) > contrastRatio(ink, best) ? fill : best));
}

const PANE_REACH = [1, 1.5, 2, 3, 4] as const;

function panesOn(surface: string, accent: string, dark: boolean, ink: string, selectedInk: string): PaneTones {
  const steps = dark ? PANE_STEPS.dark : PANE_STEPS.light;
  const readable = (step: number) => contrastRatio(ink, toneStep(surface, accent, step));
  const sign = readable(steps.rest) >= MIN_PANE_TEXT_CONTRAST || readable(steps.rest) >= readable(-steps.rest) ? 1 : -1;
  const reach = PANE_REACH.find((k) => readable(sign * k * steps.rest) >= MIN_PANE_TEXT_CONTRAST) ?? Math.max(...PANE_REACH);
  const at = (step: number) => toneStep(surface, accent, sign * (step + (reach - 1) * steps.rest));
  const rest = at(steps.rest);
  return {
    rest,
    hover: at(steps.hover),
    pressed: at(steps.pressed),
    selected: shownPane(surface, accent, steps.selected, selectedInk, rest),
  };
}

const cache = new WeakMap<object, ProfileSurfaces>();

export function profileSurfaces(theme: Pick<Theme, "dark" | "windowTint" | "tabSelected" | "tabHover" | "rowSelectedText" | "textTab" | "backdrop" | "custom">): ProfileSurfaces {
  let surfaces = cache.get(theme);
  if (surfaces) return surfaces;
  const [top, bottom] = theme.windowTint.map((c) => parseColor(c));
  const sidebar = theme.custom ? theme.windowTint[0] : toHex([0, 1, 2].map((i) => (top![i]! + bottom![i]!) / 2));
  const selectedRow = over(hex(theme.tabSelected), sidebar);
  const hoveredRow = over(hex(theme.tabHover), sidebar);
  const accent = theme.custom ? sidebar : theme.backdrop.tintColor;
  const activePanes = panesOn(selectedRow, accent, theme.dark, theme.textTab, theme.rowSelectedText);
  surfaces = {
    sidebar,
    selectedRow,
    ghost: toneStep(selectedRow, accent, lightInk(theme.rowSelectedText) ? -GHOST_STEP.deeper : GHOST_STEP.lighter),
    ghostText: theme.rowSelectedText,
    activePanes,
    idlePanes: panesOn(hoveredRow, accent, theme.dark, theme.textTab, theme.rowSelectedText),
    emptySlot: activePanes.hover,
  };
  cache.set(theme, surfaces);
  return surfaces;
}

export function contrastRatio(text: string, fill: string): number {
  const shown = over(hex(text), fill);
  const [x, y] = [luminance(shown), luminance(fill)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
