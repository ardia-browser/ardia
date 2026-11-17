export function getWindow(count: number, first: number, last: number, overscanCount: number, minCapacity = 0): { start: number; capacity: number } {
  if (count === 0) return { start: 0, capacity: 0 };
  const shown = Math.max(0, Math.min(first, count - 1));
  const through = Math.max(shown, Math.min(last, count - 1));
  const step = Math.max(1, overscanCount);
  const start = Math.max(0, Math.floor((shown - overscanCount) / step) * step);
  const end = Math.min(count, Math.ceil((through + 1 + overscanCount) / step) * step);
  const needed = end - start;
  let capacity = minCapacity;
  if (needed > capacity) capacity = capacity === 0 ? needed : needed + step;
  capacity = Math.min(count, capacity);
  return { start: Math.min(start, count - capacity), capacity };
}

export function getSlotIndices(start: number, capacity: number): number[] {
  if (capacity === 0) return [];
  return Array.from({ length: capacity }, (_, slot) => start + ((slot - (start % capacity) + capacity) % capacity));
}
