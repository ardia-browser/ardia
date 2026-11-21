export function revealedOffset(index: number, offset: number, viewport: number, card: number, stride: number) {
  const left = index * stride;
  const right = left + card;
  if (left < offset) return left;
  if (right > offset + viewport) return right - viewport;
  return offset;
}
