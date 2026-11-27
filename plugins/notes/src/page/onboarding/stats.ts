export const STATS_KEY = "ardia-notes-stats";

export function readStats(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function countStat(key: string) {
  if (!/^[a-z0-9._-]{1,64}$/.test(key)) return;
  const stats = readStats();
  stats[key] = (stats[key] ?? 0) + 1;
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {}
}
