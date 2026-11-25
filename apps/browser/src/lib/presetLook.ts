import { hexColor, lookAngle, padPosition, type PresetLookFields, type PresetThemes, type ProfileColor, type ProfileTheme, type ThemeLook } from "./profileLook";

export function presetStartingTheme(swatch: string): ProfileTheme {
  const color = hexColor(swatch);
  return { stops: [{ ...padPosition(color), color }], intensity: 0.6, mode: "auto", grain: 0, texture: "grain", translucency: 1 };
}

const ownLooksOf = (profile: PresetLookFields): PresetThemes => profile.presetThemes ?? {};

export function presetThemeOf(profile: PresetLookFields, color: ProfileColor): ProfileTheme | null {
  if (color === profile.color) return profile.theme ?? null;
  return ownLooksOf(profile)[color] ?? null;
}

const SAME_VALUE = 1e-9;
const SAME_COLOUR = 0.002;
const SAME_ANGLE = 0.5;

const near = (a: number, b: number, within = SAME_VALUE) => Math.abs(a - b) <= within;

function sameLook(a: ThemeLook, b: ThemeLook): boolean {
  if (a.texture !== b.texture || a.stops.length !== b.stops.length) return false;
  if (!near(a.intensity, b.intensity) || !near(a.grain, b.grain) || !near(a.translucency, b.translucency) || !near(lookAngle(a), lookAngle(b), SAME_ANGLE)) return false;
  return a.stops.every((s, i) => {
    const o = b.stops[i]!;
    const colour = (x: number, y: number) => near(x, y, SAME_COLOUR);
    return near(s.x, o.x) && near(s.y, o.y) && colour(s.color.r, o.color.r) && colour(s.color.g, o.color.g) && colour(s.color.b, o.color.b) && colour(s.color.a, o.color.a);
  });
}

export function snapToStart(value: number, start: number, trackPixels: number): number {
  return Math.abs(value - start) * trackPixels <= 0.5 ? start : value;
}

export function snapPointToStart(point: { x: number; y: number }, start: { x: number; y: number }, padPixels: number): { x: number; y: number } {
  return Math.abs(point.x - start.x) * padPixels <= 0.5 && Math.abs(point.y - start.y) * padPixels <= 0.5 ? { x: start.x, y: start.y } : point;
}

export function isUntouched(theme: ProfileTheme, start: ProfileTheme): boolean {
  return !theme.dark && sameTheme(theme, start);
}

export function sameTheme(a: ProfileTheme | null | undefined, b: ProfileTheme | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.mode !== b.mode || !sameLook(a, b)) return false;
  return a.dark && b.dark ? sameLook(a.dark, b.dark) : !a.dark && !b.dark;
}

type OwnLook = { theme: ProfileTheme | null; presetThemes: PresetThemes };

export function withOwnLook(profile: PresetLookFields, theme: ProfileTheme | null): OwnLook {
  const { [profile.color]: _replaced, ...others } = ownLooksOf(profile);
  return { theme, presetThemes: theme ? { ...others, [profile.color]: theme } : others };
}

type PresetChoice = { color: ProfileColor; theme: ProfileTheme | null };

export function withPresetChosen(profile: PresetLookFields, color: ProfileColor): PresetChoice | null {
  if (color === profile.color) return null;
  return { color, theme: ownLooksOf(profile)[color] ?? null };
}

type SyncedColor = { color: ProfileColor; theme: ProfileTheme | null | undefined };

export function withSyncedColor(profile: PresetLookFields, color: ProfileColor, synced: ProfileTheme | null | undefined): SyncedColor | null {
  return color === profile.color ? null : { color, theme: synced };
}

export function editedPresetCount(profile: PresetLookFields): number {
  return Object.keys(ownLooksOf(profile)).length;
}

export function withOwnLooksSeeded<T extends PresetLookFields & { seenTheme?: ProfileTheme | null; seenColor?: ProfileColor }>(profile: T): T {
  const seen = { seenTheme: profile.theme ?? null, seenColor: profile.color };
  if (profile.presetThemes === undefined) return { ...profile, presetThemes: profile.theme ? { [profile.color]: profile.theme } : {}, ...seen };
  const shown = profile.theme ?? null;
  if (profile.seenTheme === undefined || JSON.stringify(shown) === JSON.stringify(profile.seenTheme)) return profile;
  const pickedElsewhere = !shown && profile.seenColor !== undefined && profile.seenColor !== profile.color;
  if (pickedElsewhere) return { ...profile, ...seen };
  const { [profile.color]: _replaced, ...others } = profile.presetThemes;
  return { ...profile, presetThemes: shown ? { ...others, [profile.color]: shown } : others, ...seen };
}

export const profilesWithOwnLooks = <T extends PresetLookFields>(profiles: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(profiles).map(([id, profile]) => [id, withOwnLooksSeeded(profile)]));

export function trackPress() {
  let armed = false;
  return {
    armed: () => armed,
    grant(trackPixels: number) {
      armed = trackPixels > 0;
    },
    at(pageX: number, trackX: number, trackPixels: number, snapTo: number | undefined): number | null {
      return armed ? trackValueAt(pageX, trackX, trackPixels, snapTo) : null;
    },
  };
}

export function trackValueAt(pageX: number, trackX: number, trackPixels: number, snapTo: number | undefined): number | null {
  if (!(trackPixels > 0)) return null;
  const value = Math.min(1, Math.max(0, (pageX - trackX) / trackPixels));
  return snapTo === undefined ? value : snapToStart(value, snapTo, trackPixels);
}
