import { GRAPHIC, TEXT, clearOf, contrast, hexOf, mix, rgbOf, softest, towards, weakest, type Rgb } from "../lib/contrast.ts";

export const BRUSH_HEADROOM = 1.1;
export const INK_FLOOR = 8;
const SECONDARY_SHARE = 0.5;
const LABEL_SHARE = 0.36;
const SECONDARY_LIFT = 1.2;

const INK = "#16130f";
const NIGHT_INK = "#efe8dc";
const FOREST_DEEP = "#113d2e";
const SUN = "#fbb927";
const RUST = "#b4532a";

export type BandName =
  | "noon"
  | "golden"
  | "afternoon"
  | "dusk"
  | "plum"
  | "night"
  | "midnight"
  | "midmorning"
  | "daylong"
  | "sundown";

interface Band {
  readonly stops: readonly (readonly [string, number])[];
  readonly dab: string;
}

export const BANDS: Record<BandName, Band> = {
  noon: { stops: [["#f3e9d6", 0], ["#f3e7cf", 45], ["#f0c983", 100]], dab: "var(--forest)" },
  golden: { stops: [["#f0c983", 0], ["#f2d39b", 40], ["#eab47f", 100]], dab: "var(--forest)" },
  afternoon: { stops: [["#eab47f", 0], ["#e8a682", 100]], dab: "var(--forest)" },
  dusk: { stops: [["#e69b92", 0], ["#e09f91", 40], ["#dca0a3", 100]], dab: "var(--sun)" },
  plum: { stops: [["#4a3a69", 0], ["#473a68", 50], ["#433b68", 100]], dab: "var(--sun)" },
  night: { stops: [["#433b68", 0], ["#373d69", 40], ["#2c416c", 100]], dab: "var(--sun)" },
  midnight: { stops: [["#1d2b4c", 0], ["#121a2e", 40], ["#0d1424", 100]], dab: "var(--sun)" },
  midmorning: { stops: [["#e9ead8", 0], ["#f3e7cf", 40], ["#f2d39b", 100]], dab: "var(--forest)" },
  daylong: { stops: [["#e9ead8", 0], ["#f3e7cf", 22], ["#f2d39b", 70], ["#eab47f", 100]], dab: "var(--forest)" },
  sundown: { stops: [["#e3a585", 0], ["#e09f91", 50], ["#dca0a3", 100]], dab: "var(--sun)" },
};

export interface Tokens {
  readonly dark: boolean;
  readonly ink: string;
  readonly ink2: string;
  readonly ink3: string;
  readonly inkOn: string;
  readonly figure: string;
  readonly stamp: string;
  readonly rival: string;
  readonly ground: string;
}

const groundsOf = (band: Band): Rgb[] => band.stops.map(([colour]) => rgbOf(colour));

export function tokensOf(name: BandName): Tokens {
  const grounds = groundsOf(BANDS[name]);
  const text = TEXT + BRUSH_HEADROOM;
  const graphic = GRAPHIC + BRUSH_HEADROOM / 3;
  const dark = weakest(rgbOf(NIGHT_INK), grounds) > weakest(rgbOf(INK), grounds);
  const ink = rgbOf(dark ? NIGHT_INK : INK);
  const away = dark ? "lighter" : "darker";
  return {
    dark,
    ink: hexOf(ink),
    ink2: hexOf(towards(ink, grounds, Math.max(text * SECONDARY_LIFT, weakest(ink, grounds) * SECONDARY_SHARE))),
    ink3: hexOf(towards(ink, grounds, Math.max(text, weakest(ink, grounds) * LABEL_SHARE))),
    inkOn: dark ? INK : NIGHT_INK,
    figure: hexOf(clearOf(rgbOf(dark ? SUN : FOREST_DEEP), grounds, text, away)),
    stamp: hexOf(clearOf(rgbOf(dark ? SUN : RUST), grounds, text, away)),
    rival: hexOf(softest(ink, grounds, graphic, 0.6)),
    ground: hexOf(grounds[Math.floor(grounds.length / 2)]),
  };
}

export interface Pair {
  readonly band: BandName;
  readonly token: string;
  readonly ground: string;
  readonly ratio: number;
  readonly need: number;
}

export function pairs(): Pair[] {
  return (Object.keys(BANDS) as BandName[]).flatMap((band) => {
    const tokens = tokensOf(band);
    const roles: [string, string, number][] = [
      ["ink", tokens.ink, TEXT],
      ["ink-2", tokens.ink2, TEXT],
      ["ink-3", tokens.ink3, TEXT],
      ["figure", tokens.figure, TEXT],
      ["stamp", tokens.stamp, TEXT],
      ["rival", tokens.rival, GRAPHIC],
    ];
    return BANDS[band].stops.flatMap(([ground]) =>
      roles.map(([token, colour, need]) => ({ band, token, ground, ratio: contrast(rgbOf(colour), rgbOf(ground)), need })),
    );
  });
}

export function paintCss(): string {
  return (Object.keys(BANDS) as BandName[])
    .map((name) => {
      const band = BANDS[name];
      const tokens = tokensOf(name);
      const ink = rgbOf(tokens.ink);
      const ground = rgbOf(tokens.ground);
      const wash = band.stops.map(([colour, at]) => `${colour} ${at}%`).join(", ");
      const declarations = [
        `--bg: ${tokens.ground}`,
        `--bg-top: ${band.stops[0][0]}`,
        `--wash: linear-gradient(180deg, ${wash})`,
        `--dab: ${band.dab}`,
        `--ink: ${tokens.ink}`,
        `--ink-2: ${tokens.ink2}`,
        `--ink-3: ${tokens.ink3}`,
        `--ink-on: ${tokens.inkOn}`,
        `--figure: ${tokens.figure}`,
        `--stamp: ${tokens.stamp}`,
        `--rival: ${tokens.rival}`,
        `--ground: ${tokens.ground}`,
        `--rule: ${hexOf(mix(ground, ink, 0.2))}`,
        `--rule-strong: ${hexOf(mix(ground, ink, 0.85))}`,
        `--selection: ${tokens.dark ? "rgb(251 185 39 / 0.34)" : "rgb(17 61 46 / 0.22)"}`,
        `color: var(--ink)`,
      ];
      return `[data-paint="${name}"]{${declarations.join(";")}}`;
    })
    .join("\n");
}
