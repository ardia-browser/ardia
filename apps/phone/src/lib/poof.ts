export const POOF = { count: 9, durationMs: 420, iPhoneDurationMs: 300, opacity: 0.95, blurFrom: 2, blurGrow: 4, sizeShare: 0.9, centerShare: 0.21, roomAbove: 0.5 } as const;

export const poofCentreY = (y: number, size: number, top: number): number => Math.max(y, top + size * POOF.roomAbove);

function angle(index: number): number {
  "worklet";
  return (index / POOF.count) * 2 * Math.PI + (index % 2 === 0 ? 0.2 : -0.15);
}

function distance(index: number): number {
  "worklet";
  return index % 3 === 0 ? 0.46 : 0.36;
}

function radius(index: number): number {
  "worklet";
  return index % 2 === 0 ? 0.2 : 0.15;
}

export function poofPuff(index: number, t: number, size: number): { dx: number; dy: number; radius: number } {
  "worklet";
  if (index >= POOF.count) return { dx: 0, dy: 0, radius: size * POOF.centerShare * (1 - 0.5 * t) };
  const travel = size * distance(index) * (0.35 + 0.65 * t);
  const a = angle(index);
  return { dx: Math.cos(a) * travel, dy: Math.sin(a) * travel, radius: size * radius(index) * (0.45 + 0.75 * t) };
}
