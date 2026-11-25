export function windowGaps(ticks, from, to, period) {
  let maxGap = 0;
  let late = 0;
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1];
    const b = ticks[i];
    if (b <= from || a >= to) continue;
    maxGap = Math.max(maxGap, Math.min(b, to) - Math.max(a, from));
    for (let due = a + period; due < b - period / 2; due += period) if (due >= from && due < to) late++;
  }
  return { maxGap, late };
}
