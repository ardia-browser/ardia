export type Rgb = readonly [number, number, number];

export const TEXT = 4.5;
export const GRAPHIC = 3;

export const rgbOf = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;

export const hexOf = (colour: Rgb) =>
  `#${colour.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;

const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const encoded = (value: number) => 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);

export const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

export const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

export const weakest = (colour: Rgb, grounds: readonly Rgb[]) => Math.min(...grounds.map((ground) => contrast(colour, ground)));

export const mix = (a: Rgb, b: Rgb, share: number): Rgb => a.map((channel, i) => channel + (b[i] - channel) * share) as unknown as Rgb;

const oklab = (colour: Rgb) => {
  const [r, g, b] = colour.map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const fromOklab = ([L, a, b]: number[]): Rgb => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((value) => encoded(Math.min(1, Math.max(0, value)))) as unknown as Rgb;
};

const LIGHTNESS_STEP = 0.01;
const GAMUT_EASE = 0.95;

export const clearOf = (colour: Rgb, grounds: readonly Rgb[], need: number, towards: "darker" | "lighter"): Rgb => {
  let [L, a, b] = oklab(colour);
  let cleared = colour;
  while (weakest(cleared, grounds) < need && L > 0 && L < 1) {
    L = Math.min(1, Math.max(0, L + (towards === "darker" ? -LIGHTNESS_STEP : LIGHTNESS_STEP)));
    if (L < 0.2 || L > 0.92) [a, b] = [a * GAMUT_EASE, b * GAMUT_EASE];
    cleared = fromOklab([L, a, b]);
  }
  return cleared;
};

export const softest = (ink: Rgb, grounds: readonly Rgb[], need: number, wanted: number): Rgb => {
  const middle = grounds[Math.floor(grounds.length / 2)];
  let share = wanted;
  let soft = mix(ink, middle, share);
  while (share > 0 && weakest(soft, grounds) < need) {
    share = Math.max(0, share - 0.01);
    soft = mix(ink, middle, share);
  }
  return soft;
};

export const towards = (ink: Rgb, grounds: readonly Rgb[], target: number): Rgb => {
  const middle = grounds[Math.floor(grounds.length / 2)];
  let [near, far] = [0, 1];
  for (let step = 0; step < 24; step++) {
    const share = (near + far) / 2;
    if (weakest(mix(ink, middle, share), grounds) >= target) near = share;
    else far = share;
  }
  return mix(ink, middle, near);
};
