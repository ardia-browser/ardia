import type { ScopeState } from "../scopeState.ts";

type ViewThemeStop = { color: { r: number; g: number; b: number; a: number }; x: number; y: number };
type ViewThemeTexture = "grain" | "sand" | "denim" | "tweed";
type ViewThemeLook = { stops: ViewThemeStop[]; intensity: number; grain: number; texture: ViewThemeTexture; translucency: number; angle: number };
export type ViewTheme = { colors: string[]; darkColors: string[] | null; mode: "auto" | "light" | "dark"; look: ViewThemeLook; dark: ViewThemeLook | null };

function hex(n: unknown) {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  return Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase();
}

function colorsOf(look: unknown): string[] | null {
  if (!look || typeof look !== "object" || !Array.isArray((look as { stops?: unknown }).stops)) return null;
  const out: string[] = [];
  for (const stop of (look as { stops: unknown[] }).stops.slice(0, 16)) {
    if (out.length >= 3) break;
    const c = (stop as { color?: Record<string, unknown> } | null)?.color;
    if (!c || ![c.r, c.g, c.b].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 4)) continue;
    const alpha = typeof c.a === "number" && Number.isFinite(c.a) ? Math.min(1, Math.max(0, c.a)) : 1;
    out.push(`#${hex(c.r)}${hex(c.g)}${hex(c.b)}${alpha < 1 ? hex(alpha) : ""}`);
  }
  return out.length ? out : null;
}

const TEXTURES: readonly ViewThemeTexture[] = ["grain", "sand", "denim", "tweed"];
const DEFAULT_ANGLE = 135;
const unit = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
const degrees = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? ((v % 360) + 360) % 360 : null);

function themeLookOf(look: unknown, angle: unknown): ViewThemeLook | null {
  if (!look || typeof look !== "object" || !Array.isArray((look as { stops?: unknown }).stops)) return null;
  const t = look as Record<string, unknown>;
  const stops: ViewThemeStop[] = [];
  for (const raw of (t.stops as unknown[]).slice(0, 16)) {
    if (stops.length >= 3) break;
    const s = raw as Record<string, unknown> | null;
    const c = s?.color as Record<string, unknown> | undefined;
    if (!c || ![c.r, c.g, c.b].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 4)) continue;
    stops.push({ color: { r: c.r as number, g: c.g as number, b: c.b as number, a: unit(c.a, 1) }, x: unit(s!.x, 0.5), y: unit(s!.y, 0.5) });
  }
  if (!stops.length) return null;
  return {
    stops,
    intensity: unit(t.intensity, 0.6),
    grain: unit(t.grain, 0),
    texture: TEXTURES.includes(t.texture as ViewThemeTexture) ? (t.texture as ViewThemeTexture) : "grain",
    translucency: unit(t.translucency, 1),
    angle: degrees(angle) ?? degrees(t.angle) ?? DEFAULT_ANGLE,
  };
}

export function themeOf(app: ScopeState, syncId: string, profileTheme: unknown): ViewTheme | null {
  const record = app.records[`pth:${syncId}`]?.v as Record<string, unknown> | null | undefined;
  const theme = record ? (record.preset === true ? null : record.t) : profileTheme;
  const colors = colorsOf(theme);
  if (!colors) return null;
  const angles = (record ? app.records[`pth:${syncId}:angle`]?.v : null) as Record<string, unknown> | null | undefined;
  const t = theme as Record<string, unknown>;
  const look = themeLookOf(theme, angles?.a);
  if (!look) return null;
  const lightAngle = degrees(angles?.a) ?? degrees(t.angle);
  const dark = themeLookOf(t.dark, angles?.d ?? (t.dark as Record<string, unknown> | undefined)?.angle ?? lightAngle);
  const mode = t.mode === "light" || t.mode === "dark" ? t.mode : "auto";
  return { colors, darkColors: colorsOf(t.dark), mode, look, dark };
}
