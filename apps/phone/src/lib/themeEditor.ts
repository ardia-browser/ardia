import { colorHex, padColor, requestedDarkFor, resolveTheme, shownLook, withStopAt, type ProfileTheme, type ThemeLook, type ThemeMode } from "@ardia/core/src/theme.ts";

export type PadPoint = { x: number; y: number };

export const THEME_MODES: readonly { id: ThemeMode; title: string }[] = [
  { id: "light", title: "Light" },
  { id: "dark", title: "Dark" },
  { id: "auto", title: "Match System" },
];

export const TEXTURE_NAMES = { grain: "Grain", sand: "Sand", denim: "Denim", tweed: "Tweed" } as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function padPoint(x: number, y: number, side: number): PadPoint {
  const p = { x: clamp01(x / side), y: clamp01(y / side) };
  const dx = p.x - 0.5, dy = p.y - 0.5, r = Math.hypot(dx, dy);
  return r <= 0.5 ? p : { x: 0.5 + (dx / r) * 0.5, y: 0.5 + (dy / r) * 0.5 };
}

export function stopAt(theme: ThemeLook, x: number, y: number, side: number, reach: number): number {
  const p = { x: x / side, y: y / side };
  return theme.stops.findIndex((s) => Math.hypot((s.x - p.x) * side, (s.y - p.y) * side) <= reach);
}

export function dialAngle(dx: number, dy: number, snap: number, notch: number): number {
  const degrees = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const nearest = Math.round(degrees / notch) * notch;
  return (Math.abs(degrees - nearest) <= snap ? nearest : Math.round(degrees)) % 360;
}

export function turnedStop<T extends ThemeLook>(theme: T, index: number, turns: number): T {
  const stop = theme.stops[index];
  if (!stop) return theme;
  const angle = Math.atan2(stop.y - 0.5, stop.x - 0.5) + turns * 2 * Math.PI;
  const radius = Math.max(0.3, Math.hypot(stop.x - 0.5, stop.y - 0.5));
  return withStopAt(theme, index, 0.5 + radius * Math.cos(angle), 0.5 + radius * Math.sin(angle));
}

export const stepped = (value: number, by: number) => Math.round(clamp01(value + by) * 100) / 100;

export function editedLook(stored: ProfileTheme, dark: boolean): { theme: ProfileTheme; editsDark: boolean | null } {
  if (!stored.dark) return { theme: stored, editsDark: null };
  const editsDark = requestedDarkFor(stored, dark, "own");
  return { theme: resolveTheme(stored, editsDark), editsDark };
}

export function keptReadable(theme: ProfileTheme, dark: boolean): boolean {
  return [false, true].some((appDark) => {
    const shown = shownLook(theme, appDark, "own");
    return shown.requestedDark !== dark && shown.dark === dark;
  });
}

export function rainbow(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / (count - 1)) * 2 * Math.PI;
    return colorHex(padColor(0.5 + 0.5 * Math.cos(angle), 0.5 + 0.5 * Math.sin(angle)));
  });
}

export function padWedges(count: number, side: number): { path: string; fill: string }[] {
  const r = side / 2;
  return Array.from({ length: count }, (_, i) => {
    const from = (i / count) * 2 * Math.PI - 0.01, to = ((i + 1) / count) * 2 * Math.PI + 0.01;
    const middle = ((i + 0.5) / count) * 2 * Math.PI;
    const at = (a: number) => `${(r + r * Math.cos(a)).toFixed(3)} ${(r + r * Math.sin(a)).toFixed(3)}`;
    return { path: `M ${r} ${r} L ${at(from)} A ${r} ${r} 0 0 1 ${at(to)} Z`, fill: colorHex(padColor(0.5 + 0.5 * Math.cos(middle), 0.5 + 0.5 * Math.sin(middle))) };
  });
}

export function demoTheme(): ProfileTheme {
  const stop = (x: number, y: number) => ({ color: padColor(x, y), x, y });
  return { stops: [stop(0.86, 0.42), stop(0.3, 0.18), stop(0.62, 0.88)], intensity: 0.8, grain: 0.7, texture: "sand", translucency: 0.5, angle: 225, mode: "auto" };
}

export const padCentre = () => colorHex(padColor(0.5, 0.5));

export function lightnessSteps(stop: { x: number; y: number }, count: number): string[] {
  return Array.from({ length: count }, (_, i) => colorHex(padColor(stop.x, stop.y, i / (count - 1))));
}
