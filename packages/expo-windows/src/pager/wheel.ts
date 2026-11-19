export const WHEEL_DELTA_PER_POINT = 12;

export function wheelSwipe(delta: number, canSwipeBack: boolean, canSwipeForward: boolean, width: number) {
  const back = delta < 0;
  return { phase: "wheel" as const, direction: back ? ("back" as const) : ("forward" as const), distance: Math.abs(delta) / WHEEL_DELTA_PER_POINT, dy: 0, velocity: 0, available: back ? canSwipeBack : canSwipeForward, width };
}
