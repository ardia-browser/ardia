export const INTERFACE_SCALE = { min: 0.8, max: 1.5, step: 0.05, default: 1 } as const;

const PERCENT_STEP = Math.round(INTERFACE_SCALE.step * 100);
const MIN_PERCENT = Math.round(INTERFACE_SCALE.min * 100);
const MAX_PERCENT = Math.round(INTERFACE_SCALE.max * 100);

export const INTERFACE_SCALE_STEPS: readonly number[] = Array.from({ length: (MAX_PERCENT - MIN_PERCENT) / PERCENT_STEP + 1 }, (_, i) => (MIN_PERCENT + i * PERCENT_STEP) / 100);

export const interfaceScalePercent = (scale: number): number => Math.round(scale * 100);

export function validInterfaceScale(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const percent = interfaceScalePercent(value);
  return Math.abs(value * 100 - percent) < 1e-6 && percent >= MIN_PERCENT && percent <= MAX_PERCENT && percent % PERCENT_STEP === 0;
}

export function steppedInterfaceScale(value: number): number {
  if (!Number.isFinite(value)) return INTERFACE_SCALE.default;
  const percent = Math.round(Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, value * 100)) / PERCENT_STEP) * PERCENT_STEP;
  return percent / 100;
}

export const sameInterfaceScale = (a: number, b: number): boolean => interfaceScalePercent(a) === interfaceScalePercent(b);

export const interfaceScaleLabel = (scale: number): string => `${interfaceScalePercent(scale)}%`;

export const rootLength = (windowLength: number, scale: number): number => windowLength / scale;

export const windowLength = (rootPoints: number, scale: number): number => rootPoints * scale;

export const snappedToGrid = (value: number, pixelsPerPoint: number): number => Math.round(value * pixelsPerPoint) / pixelsPerPoint;
