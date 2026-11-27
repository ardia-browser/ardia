export const numbers = (values) => values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);

export function percentile(values, p) {
  const v = numbers(values);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1))))];
}

export const median = (values) => {
  const v = numbers(values);
  if (!v.length) return null;
  const mid = (v.length - 1) / 2;
  return (v[Math.floor(mid)] + v[Math.ceil(mid)]) / 2;
};

export const round1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

export function summarize(values) {
  const v = numbers(values);
  return { median: round1(median(v)), p95: round1(percentile(v, 95)), max: v.length ? v.at(-1) : null, n: v.length };
}
