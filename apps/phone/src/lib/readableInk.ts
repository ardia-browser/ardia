export type Channels = readonly [number, number, number, number];

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

export function inkChannels(color: string): Channels {
  const text = color.trim();
  const functional = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (functional) {
    const parts = functional[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    return [clampUnit(parts[0]! / 255), clampUnit(parts[1]! / 255), clampUnit(parts[2]! / 255), clampUnit(parts[3] ?? 1)];
  }
  const hex = text.replace("#", "");
  const full = hex.length === 3 || hex.length === 4 ? Array.from(hex, (c) => c + c).join("") : hex;
  const channel = (i: number) => parseInt(full.slice(2 * i, 2 * i + 2), 16) / 255;
  return [channel(0), channel(1), channel(2), full.length >= 8 ? channel(3) : 1];
}

export const plateLuminance = (red: number, green: number, blue: number) => 0.2126 * red ** 2.2 + 0.7152 * green ** 2.2 + 0.0722 * blue ** 2.2;

export const luminanceContrast = (one: number, other: number) => (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);

const grayLuminance = (gray: number) => plateLuminance(gray, gray, gray);

const inkOverGray = ([red, green, blue, alpha]: Channels, gray: number) =>
  plateLuminance(red * alpha + gray * (1 - alpha), green * alpha + gray * (1 - alpha), blue * alpha + gray * (1 - alpha));

export const inkContrastOverGray = (ink: string, gray: number) => luminanceContrast(inkOverGray(inkChannels(ink), gray), grayLuminance(gray));

export const PLATE_INK = { onDark: "rgba(255,255,255,0.8)", onLight: "rgba(14,15,16,0.9)" } as const;

export const PLATE_CONTRAST = 5;

export const READABLE_TEXT = 4.5;

export const READABLE_GLYPH = 3;

function boundGray(ink: string, dark: boolean): number {
  const reads = (gray: number) => inkContrastOverGray(ink, gray) >= PLATE_CONTRAST;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 30; step++) {
    const middle = (low + high) / 2;
    if (reads(middle) === dark) low = middle;
    else high = middle;
  }
  return dark ? low : high;
}

const ceilingGray = boundGray(PLATE_INK.onDark, true);
const floorGray = boundGray(PLATE_INK.onLight, false);

export const plateBounds = { ceiling: grayLuminance(ceilingGray), floor: grayLuminance(floorGray), ceilingGray, floorGray } as const;

export const plateGrays = (dark: boolean): readonly number[] => {
  const [from, to] = dark ? [0, ceilingGray] : [floorGray, 1];
  return Array.from({ length: 9 }, (_, index) => from + ((to - from) * index) / 8);
};

export const inkContrastOnPlate = (ink: string, dark: boolean) => Math.min(...plateGrays(dark).map((gray) => inkContrastOverGray(ink, gray)));

export const plateInkFor = (dark: boolean) => (dark ? PLATE_INK.onDark : PLATE_INK.onLight);

const liftCache = new Map<string, string>();

export function liftedInk(ink: string, dark: boolean, target: number): string {
  const key = `${ink}|${dark}|${target}`;
  const known = liftCache.get(key);
  if (known !== undefined) return known;
  const made = lift(ink, dark, target);
  liftCache.set(key, made);
  return made;
}

function lift(ink: string, dark: boolean, target: number): string {
  if (inkContrastOnPlate(ink, dark) >= target) return ink;
  const [red, green, blue, alpha] = inkChannels(ink);
  const reads = (channels: Channels) => inkContrastOnPlate(rgba(channels), dark) >= target;
  const polar = dark ? 1 : 0;
  let base: Channels = [red, green, blue, 1];
  if (!reads(base)) {
    let low = 0;
    let high = 1;
    for (let step = 0; step < 24; step++) {
      const middle = (low + high) / 2;
      const toward = (value: number) => value + (polar - value) * middle;
      if (reads([toward(red), toward(green), toward(blue), 1])) high = middle;
      else low = middle;
    }
    const toward = (value: number) => value + (polar - value) * high;
    base = [toward(red), toward(green), toward(blue), 1];
  }
  let low = alpha;
  let high = 1;
  for (let step = 0; step < 24; step++) {
    const middle = (low + high) / 2;
    if (reads([base[0], base[1], base[2], middle])) high = middle;
    else low = middle;
  }
  return rgba([base[0], base[1], base[2], Math.min(1, Math.ceil(high * 1000) / 1000)]);
}

const veilOver = ([red, green, blue, alpha]: Channels, backdrop: number) =>
  plateLuminance(red * alpha + backdrop * (1 - alpha), green * alpha + backdrop * (1 - alpha), blue * alpha + backdrop * (1 - alpha));

const veilFits = (veil: Channels, dark: boolean) => (dark ? veilOver(veil, 1) <= plateBounds.ceiling : veilOver(veil, 0) >= plateBounds.floor);

const rgba = ([red, green, blue, alpha]: Channels) => `rgba(${Math.round(red * 255)},${Math.round(green * 255)},${Math.round(blue * 255)},${Math.round(alpha * 1000) / 1000})`;

export function readableVeil(fill: string, dark: boolean): string {
  const ink = inkChannels(fill);
  if (veilFits(ink, dark)) return fill;
  let made: Channels = [ink[0], ink[1], ink[2], 1];
  if (!veilFits(made, dark)) {
    const target = dark ? 0.12 : 0.9;
    made = [target, target, target, 1];
  }
  let low = ink[3];
  let high = 1;
  for (let step = 0; step < 24; step++) {
    const middle = (low + high) / 2;
    if (veilFits([made[0], made[1], made[2], middle], dark)) high = middle;
    else low = middle;
  }
  return rgba([made[0], made[1], made[2], Math.ceil(high * 1000) / 1000]);
}

export function compositeOver(top: string, bottom: string): string {
  const [red, green, blue, alpha] = inkChannels(top);
  const under = inkChannels(bottom);
  const mix = (value: number, base: number) => Math.round((value * alpha + base * (1 - alpha)) * 255);
  return `#${[mix(red, under[0]), mix(green, under[1]), mix(blue, under[2])].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const contrastWith = (ink: string, color: string) => {
  const [red, green, blue] = inkChannels(color);
  const under = plateLuminance(red, green, blue);
  const [ir, ig, ib, ia] = inkChannels(ink);
  return luminanceContrast(plateLuminance(ir * ia + red * (1 - ia), ig * ia + green * (1 - ia), ib * ia + blue * (1 - ia)), under);
};

export function darkInkReads(colors: readonly string[]): boolean {
  const worst = (ink: string) => Math.min(...colors.map((color) => contrastWith(ink, color)));
  return worst(PLATE_INK.onLight) >= worst(PLATE_INK.onDark);
}

export const backdropIsDark = (colors: readonly string[]) => colors.length > 0 && !darkInkReads(colors);

export const androidAlwaysDark = (os: string, incognitoLook: boolean) => os === "android" && incognitoLook;

export const plateIsDark = ({ requested, incognitoLook, themeDark, os }: { requested: boolean | undefined; incognitoLook: boolean; themeDark: boolean; os: string }) =>
  androidAlwaysDark(os, incognitoLook) || (requested ?? (incognitoLook || themeDark));

export function plateFace(fill: string, dark: boolean): { fill: string; dark: boolean } {
  const alpha = inkChannels(fill)[3];
  if (alpha <= 0) return { fill, dark };
  if (alpha >= 1) return { fill, dark: backdropIsDark([fill]) };
  return { fill: readableVeil(fill, dark), dark };
}
