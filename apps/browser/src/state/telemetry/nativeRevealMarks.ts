export type Mark = [kind: string, at: number];

export const NATIVE_REVEAL_COUNTS: Record<string, string> = { nativeReveal: "j3_native", nativeRevealDropped: "j3_native_dropped" };

const pressKey = (press: number) => `press:${press}`;

export function forgetDroppedPress(marks: Map<string, Mark[]>, key: string, kind: string) {
  if (kind === "nativeRevealDropped") marks.delete(key);
}

export function nativePressTime(marks: Map<string, Mark[]>, press: number): number | null {
  if (!press) return null;
  const at = marks.get(pressKey(press))?.find(([kind]) => kind === "nativePress")?.[1] ?? null;
  marks.delete(pressKey(press));
  return at;
}
