import { SEEDED_SCHEMES, type MaterialScheme, type MaterialSchemePair } from "./schemes.ts";

export type MaterialSeed = keyof typeof SEEDED_SCHEMES;

export const MATERIAL_FALLBACK_SEED: MaterialSeed = "ardia";

const customSeed = (choice: string | null): MaterialSeed | null => choice && Object.hasOwn(SEEDED_SCHEMES, choice) && choice !== MATERIAL_FALLBACK_SEED ? choice as MaterialSeed : null;

export const wallpaperColorsEnabled = (choice: string | null, enabled: boolean | null) => enabled ?? customSeed(choice) === null;

export function schemePairFor(choice: string | null, dynamic: MaterialSchemePair | null, enabled: boolean | null = null): MaterialSchemePair {
  if (wallpaperColorsEnabled(choice, enabled)) return dynamic ?? SEEDED_SCHEMES[MATERIAL_FALLBACK_SEED];
  return SEEDED_SCHEMES[customSeed(choice) ?? "plum"];
}

export type MaterialColorSource = "wallpaper" | "profile" | "fallback" | "not_material";

export function materialColorSource(material: boolean, choice: string | null, dynamic: MaterialSchemePair | null, enabled: boolean | null = null): MaterialColorSource {
  if (!material) return "not_material";
  if (!wallpaperColorsEnabled(choice, enabled)) return "profile";
  return dynamic ? "wallpaper" : "fallback";
}

export const schemeFor = (pair: MaterialSchemePair, dark: boolean): MaterialScheme => (dark ? pair.dark : pair.light);

