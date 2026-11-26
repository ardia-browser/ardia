export type ScaledSource = { uri: string; width: number; height: number; scale: number };

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function scaledSource(source: unknown): ScaledSource | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const { uri, width, height, scale } = source as Partial<ScaledSource>;
  return typeof uri === "string" && uri && positive(width) && positive(height) && positive(scale) && scale > 1 ? { uri, width, height, scale } : null;
}

export function tiledBackground(source: unknown, resizeMode: unknown, tintColor: unknown) {
  const scaled = resizeMode === "repeat" && !tintColor ? scaledSource(source) : null;
  if (!scaled) return null;
  return {
    backgroundImage: `url(${JSON.stringify(scaled.uri)})`,
    backgroundPosition: "left top",
    backgroundRepeat: "repeat",
    backgroundSize: `${scaled.width}px ${scaled.height}px`,
  };
}
