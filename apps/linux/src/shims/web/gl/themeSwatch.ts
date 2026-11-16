import { oklab, type Vec4 } from "./colors.ts";

export const SWATCH_SAMPLES = 16;
export const SWATCH_REACH = 0.75;
export const GRAIN_SIDE = 128;
export const GRAIN_POINTS = GRAIN_SIDE / 2;

const PLAIN_GRAIN = { gain: 0.211, floor: 0 };
const GRAIN_DARKENING: Record<string, { gain: number; floor: number }> = {
  grain: PLAIN_GRAIN,
  sand: { gain: 0.937, floor: 0.132 },
  denim: { gain: 0.226, floor: 0.068 },
  tweed: { gain: 0.23, floor: 0.261 },
};

export function swatchColors(flat: readonly number[]): Vec4[] {
  const colors: Vec4[] = [];
  for (let at = 0; at + 3 < flat.length && colors.length < 3; at += 4) colors.push([flat[at]!, flat[at + 1]!, flat[at + 2]!, flat[at + 3]!]);
  return colors;
}

export function srgbFromOklab([L, a, b, alpha]: Vec4): Vec4 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (x: number) => (Math.abs(x) <= 0.0031308 ? x * 12.92 : Math.sign(x) * (1.055 * Math.pow(Math.abs(x), 1 / 2.4) - 0.055));
  return [
    encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  ];
}

export type SwatchStop = { offset: number; color: Vec4 };

export function baseStops(colors: readonly Vec4[]): SwatchStop[] {
  const first = colors[0];
  if (!first) return [];
  const a = oklab(first);
  const b = oklab(colors[1] ?? first);
  const steps = colors.length > 1 ? SWATCH_SAMPLES : 1;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return { offset: t, color: srgbFromOklab([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]) };
  });
}

export function overlayStops(colors: readonly Vec4[]): SwatchStop[] {
  const third = colors[2];
  if (!third) return [];
  return [
    { offset: 0, color: [third[0], third[1], third[2], 0] },
    { offset: 1, color: third },
  ];
}

export type SwatchLine = { x1: number; y1: number; x2: number; y2: number };

function line(width: number, height: number, degrees: number, reach: number, half: (dx: number, dy: number) => number): SwatchLine {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  const r = (degrees * Math.PI) / 180;
  const dx = Math.sin(r);
  const dy = -Math.cos(r);
  const length = half(dx, dy);
  const ax = w * dx;
  const ay = h * dy;
  const scale = (2 * length * reach) / (ax * ax + ay * ay);
  const x1 = 0.5 - (length * dx) / w;
  const y1 = 0.5 - (length * dy) / h;
  return { x1, y1, x2: x1 + ax * scale, y2: y1 + ay * scale };
}

export const baseLine = (width: number, height: number, angle: number) =>
  line(width, height, angle, SWATCH_REACH, (dx, dy) => (Math.hypot(Math.max(width, 1) * dx, Math.max(height, 1) * dy) * Math.hypot(Math.max(width, 1), Math.max(height, 1))) / (2 * Math.max(width, height, 1)));

export const overlayLine = (width: number, height: number, angle: number) =>
  line(width, height, angle + 45, 1, (dx, dy) => (Math.max(width, 1) * Math.abs(dx) + Math.max(height, 1) * Math.abs(dy)) / 2);

export function stopCss([r, g, b, a]: Vec4): { color: string; opacity: number } {
  const channel = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 255);
  return { color: `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`, opacity: Math.min(Math.max(a, 0), 1) };
}

export function grainAlpha(texture: string): Uint8ClampedArray {
  const n = GRAIN_SIDE;
  const alpha = new Float32Array(n * n);
  let state = 0x9e3779b9;
  const random = () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return Math.fround((state % 10_000) / 10_000);
  };
  const add = (x: number, y: number, v: number) => {
    const i = (((y % n) + n) % n) * n + (((x % n) + n) % n);
    alpha[i] = Math.min(1, alpha[i]! + v);
  };
  if (texture === "sand") {
    for (let i = 0; i < n * n; i++) alpha[i] = random() * 0.25;
    for (let k = 0; k < Math.floor((n * n) / 18); k++) {
      const x = Math.trunc(random() * n);
      const y = Math.trunc(random() * n);
      const v = 0.5 + random() * 0.5;
      add(x, y, v);
      add(x + 1, y, v * 0.6);
      add(x, y + 1, v * 0.6);
      add(x + 1, y + 1, v * 0.4);
    }
  } else if (texture === "denim") {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const twill = (x + y) % 4 < 2 ? 0.75 : 0.15;
        alpha[y * n + x] = Math.min(1, twill * (0.6 + random() * 0.4) + (y % 2 === 0 ? 0.08 : 0));
      }
    }
  } else if (texture === "tweed") {
    for (let i = 0; i < n * n; i++) alpha[i] = random() * 0.15;
    for (let k = 0; k < Math.floor((n * n) / 40); k++) {
      const x = Math.trunc(random() * n);
      const y = Math.trunc(random() * n);
      const v = 0.4 + random() * 0.6;
      const horizontal = random() < 0.5;
      const run = 3 + Math.trunc(random() * 4);
      for (let j = 0; j < run; j++) horizontal ? add(x + j, y, v) : add(x, y + j, v);
    }
  } else {
    for (let i = 0; i < n * n; i++) {
      const u = random();
      alpha[i] = u * u;
    }
  }
  const match = GRAIN_DARKENING[texture] ?? PLAIN_GRAIN;
  const bytes = new Uint8ClampedArray(n * n * 4);
  for (let i = 0; i < n * n; i++) bytes[i * 4 + 3] = Math.trunc(Math.min(255, Math.max(0, match.floor + match.gain * alpha[i]!) * 255));
  return bytes;
}

const HUE_STOPS = [0, 60, 120, 180, 240, 300, 360];

export function padLayers(lightness: number): { wheel: string; centre: string } {
  const percent = +(Math.min(Math.max(lightness, 0), 1) * 100).toFixed(3);
  const grey = Math.round(Math.min(Math.max(lightness, 0), 1) * 255);
  return {
    wheel: `conic-gradient(from 90deg, ${HUE_STOPS.map((hue) => `hsl(${hue} 100% ${percent}%) ${hue}deg`).join(", ")})`,
    centre: `radial-gradient(closest-side, rgba(${grey}, ${grey}, ${grey}, 1), rgba(${grey}, ${grey}, ${grey}, 0))`,
  };
}
