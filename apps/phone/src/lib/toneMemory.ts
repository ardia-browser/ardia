export type RememberedTone = { top: string | null; bottom: string | null };

const COLOUR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

const colour = (value: unknown): string | null => (typeof value === "string" && COLOUR.test(value) ? value : null);

export function parseRememberedTones(raw: string | null | undefined, keep: ReadonlySet<string>): Record<string, RememberedTone> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const tones: Record<string, RememberedTone> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!keep.has(id) || !value || typeof value !== "object") continue;
    const tone = { top: colour((value as Record<string, unknown>).top), bottom: colour((value as Record<string, unknown>).bottom) };
    if (tone.top || tone.bottom) tones[id] = tone;
  }
  return tones;
}

export function rememberedTonesText(tones: Readonly<Record<string, RememberedTone>>, keep: ReadonlySet<string>): string {
  const kept: Record<string, RememberedTone> = {};
  for (const [id, tone] of Object.entries(tones)) {
    if (!keep.has(id)) continue;
    const top = colour(tone.top);
    const bottom = colour(tone.bottom);
    if (top || bottom) kept[id] = { top, bottom };
  }
  return JSON.stringify(kept);
}
