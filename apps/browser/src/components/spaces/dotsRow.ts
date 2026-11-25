export function dotsRowLeftInset(width: number, rowWidth: number, sideRoom: number): number {
  return Math.max(0, Math.min(sideRoom, rowWidth + 2 * sideRoom - width));
}
