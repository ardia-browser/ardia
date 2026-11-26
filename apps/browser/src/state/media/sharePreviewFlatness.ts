const BLANK_KEY = "@blank";
const BLACK_KEY = "@black";

const countOf = (value: unknown) => {
  const n = typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

export function splitSharePreviews(found: Record<string, string>): { thumbs: Record<string, string>; blank: number; black: number } {
  const { [BLANK_KEY]: blank, [BLACK_KEY]: black, ...thumbs } = found;
  return { thumbs, blank: countOf(blank), black: Math.min(countOf(black), countOf(blank)) };
}
