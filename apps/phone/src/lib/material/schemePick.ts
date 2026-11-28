import { readableInkOn } from "../color.ts";
import { SEEDED_SCHEMES, type MaterialScheme, type MaterialSchemeKey, type MaterialSchemePair } from "./schemes.ts";

export type MaterialSeed = keyof typeof SEEDED_SCHEMES;

export const MATERIAL_FALLBACK_SEED: MaterialSeed = "ardia";

const customSeed = (choice: string | null): MaterialSeed | null => choice && Object.hasOwn(SEEDED_SCHEMES, choice) && choice !== MATERIAL_FALLBACK_SEED ? choice as MaterialSeed : null;

export const materialPresetFor = (choice: string | null) => (customSeed(choice) ?? "plum") as Exclude<MaterialSeed, typeof MATERIAL_FALLBACK_SEED>;

export const wallpaperColorsEnabled = (choice: string | null, enabled: boolean | null) => enabled ?? customSeed(choice) === null;

export function schemePairFor(choice: string | null, dynamic: MaterialSchemePair | null, enabled: boolean | null = null): MaterialSchemePair {
  if (wallpaperColorsEnabled(choice, enabled)) return dynamic ?? SEEDED_SCHEMES[MATERIAL_FALLBACK_SEED];
  return SEEDED_SCHEMES[materialPresetFor(choice)];
}

export type MaterialColorSource = "wallpaper" | "profile" | "fallback" | "not_material";

export function materialColorSource(material: boolean, choice: string | null, dynamic: MaterialSchemePair | null, enabled: boolean | null = null): MaterialColorSource {
  if (!material) return "not_material";
  if (!wallpaperColorsEnabled(choice, enabled)) return "profile";
  return dynamic ? "wallpaper" : "fallback";
}

export const schemeFor = (pair: MaterialSchemePair, dark: boolean): MaterialScheme => (dark ? pair.dark : pair.light);


const INK_ON_FILL: ReadonlyArray<readonly [fill: MaterialSchemeKey, ink: MaterialSchemeKey]> = [
  ["primary", "onPrimary"],
  ["primaryContainer", "onPrimaryContainer"],
  ["secondary", "onSecondary"],
  ["secondaryContainer", "onSecondaryContainer"],
  ["tertiary", "onTertiary"],
  ["tertiaryContainer", "onTertiaryContainer"],
  ["background", "onBackground"],
  ["surface", "onSurface"],
  ["surfaceVariant", "onSurfaceVariant"],
  ["inverseSurface", "inverseOnSurface"],
  ["error", "onError"],
  ["errorContainer", "onErrorContainer"],
];

export function readableScheme(scheme: MaterialScheme): MaterialScheme {
  let fixed: MaterialScheme | null = null;
  for (const [fill, ink] of INK_ON_FILL) {
    const readable = readableInkOn(scheme[fill], scheme[ink]);
    if (readable === scheme[ink]) continue;
    fixed ??= { ...scheme };
    fixed[ink] = readable;
  }
  return fixed ?? scheme;
}

export function readableSchemePair(pair: MaterialSchemePair | null): MaterialSchemePair | null {
  if (!pair) return null;
  const light = readableScheme(pair.light);
  const dark = readableScheme(pair.dark);
  return light === pair.light && dark === pair.dark ? pair : { light, dark };
}

export const unreadableInks = (scheme: MaterialScheme): MaterialSchemeKey[] => INK_ON_FILL.filter(([fill, ink]) => readableInkOn(scheme[fill], scheme[ink]) !== scheme[ink]).map(([, ink]) => ink);
