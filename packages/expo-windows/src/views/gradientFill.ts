import type { SurfaceProps } from "@ardia/shell";
import { mixOklab, parseColor, type Rgba } from "./color";

type GradientFillSource = Pick<SurfaceProps, "fill" | "fillColors" | "fillStops" | "fade" | "fadeStops">;

export type GradientFill = { stops: Rgba[]; places?: number[]; fade?: number[]; fadePlaces?: number[] };

type Strip = { at: number; size: number };

type FallbackRow = Strip & { color: Rgba };

type FallbackColumn = Strip & { opacity: number };

const FALLBACK_ROWS = 12;
const FALLBACK_COLUMNS = 10;

const numbers = (value: unknown): number[] | undefined =>
  Array.isArray(value) && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? (value as number[]) : undefined;

const placedFor = (places: number[] | undefined, count: number) => (places && places.length === count ? places : undefined);

export function gradientFill({ fill, fillColors, fillStops, fade, fadeStops }: GradientFillSource): GradientFill | null {
  const alphas = numbers(fade);
  const faded = alphas && alphas.length >= 2 ? alphas : undefined;
  const parsed = Array.isArray(fillColors) ? fillColors.map(parseColor) : [];
  const listed = parsed.length >= 2 && parsed.every((stop): stop is Rgba => !!stop) ? parsed : null;
  const solid = parseColor(fill);
  const stops = listed ?? (faded && solid ? [solid, solid] : null);
  if (!stops) return null;
  return {
    stops,
    places: listed ? placedFor(numbers(fillStops), listed.length) : undefined,
    fade: faded,
    fadePlaces: faded ? placedFor(numbers(fadeStops), faded.length) : undefined,
  };
}

export const flatColors = (stops: readonly Rgba[]) => stops.flatMap((stop) => [...stop]);

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

const placesOf = (count: number, places: readonly number[] | undefined) =>
  places ? places.map(clampUnit) : Array.from({ length: count }, (_, i) => (count <= 1 ? 0 : i / (count - 1)));

function spanAt<T>(values: readonly T[], places: readonly number[], t: number): [T, T, number] {
  if (t <= places[0]!) return [values[0]!, values[0]!, 0];
  for (let i = 1; i < values.length; i++) {
    if (t <= places[i]!) {
      const width = places[i]! - places[i - 1]!;
      return [values[i - 1]!, values[i]!, width > 0 ? (t - places[i - 1]!) / width : 1];
    }
  }
  return [values[values.length - 1]!, values[values.length - 1]!, 0];
}

function colorAt(gradient: GradientFill, t: number): Rgba {
  const [from, to, k] = spanAt(gradient.stops, placesOf(gradient.stops.length, gradient.places), t);
  return mixOklab(from, to, k);
}

function fadeAt(gradient: GradientFill, t: number): number {
  if (!gradient.fade) return 1;
  const [from, to, k] = spanAt(gradient.fade, placesOf(gradient.fade.length, gradient.fadePlaces), t);
  return clampUnit(from + (to - from) * k);
}

function stripsBetween(places: readonly number[], target: number): Strip[] {
  const edges = [...new Set([0, ...places.map(clampUnit), 1])].sort((a, b) => a - b);
  const strips: Strip[] = [];
  for (let i = 1; i < edges.length; i++) {
    const width = edges[i]! - edges[i - 1]!;
    if (!(width > 0)) continue;
    const parts = Math.max(1, Math.round(width * target));
    for (let p = 0; p < parts; p++) strips.push({ at: edges[i - 1]! + (width * p) / parts, size: width / parts });
  }
  return strips;
}

export const fallbackRows = (gradient: GradientFill): FallbackRow[] =>
  stripsBetween(placesOf(gradient.stops.length, gradient.places), FALLBACK_ROWS).map((row) => ({ ...row, color: colorAt(gradient, row.at + row.size / 2) }));

export const fallbackColumns = (gradient: GradientFill): FallbackColumn[] =>
  gradient.fade
    ? stripsBetween(placesOf(gradient.fade.length, gradient.fadePlaces), FALLBACK_COLUMNS).map((column) => ({ ...column, opacity: fadeAt(gradient, column.at + column.size / 2) }))
    : [{ at: 0, size: 1, opacity: 1 }];
