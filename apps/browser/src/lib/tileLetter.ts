import { displayHostOf } from "./url";
import { graphemeClusters, isControl, isPictographic, startsCluster } from "./graphemes";

const LETTER = /(?![\u115F\u1160\u3164\uFFA0])\p{L}/u;
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/u;
const drawsSomething = (cluster: string) => [...cluster].some((char) => !INVISIBLE.test(char));
const isTag = (char: string) => char >= "\u{E0020}" && char <= "\u{E007F}";
const withoutRepeatedInvisibles = (cluster: string) => [...cluster].filter((char, i, chars) => !(char === chars[i - 1] && INVISIBLE.test(char) && !isTag(char))).join("");

const firstLetter = (text: string): string | null => {
  for (const char of text) if (LETTER.test(char)) return char.toLocaleUpperCase();
  return null;
};

const SECOND_LEVEL = /^(?:co|com|net|org|gov|edu|ac|ne|or|go)$/;

function siteName(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return host;
  const suffix = labels.length > 2 && SECOND_LEVEL.test(labels[labels.length - 2]!) ? 2 : 1;
  return labels[labels.length - 1 - suffix] ?? host;
}

export function tileLetterOf(url: string, title: string): string {
  const host = url ? siteName(displayHostOf(url)) : "";
  const fromHost = host && LETTER.test([...host][0] ?? "") ? firstLetter(host) : null;
  return fromHost ?? firstLetter(title) ?? "•";
}

export const TILE_LETTERS_MAX = 2;
export const TILE_LETTERS_MAX_LENGTH = 24;

const SPACE = /[\t\n\v\f\r \u0085\u00A0\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF\uE000-\uF8FF\u{F0000}-\u{10FFFF}]/u;
const unseen = (char: string) => SPACE.test(char) || isControl(char.codePointAt(0)!);
const withoutUnseen = (text: string) => [...text].filter((char) => !unseen(char)).join("");
const BASIC_PLANE_RUN = /[\u0000-\uD7FF\uE000-\uFFFF]+/g;
const inBasicPlane = (text: string, change: (run: string) => string) => text.replace(BASIC_PLANE_RUN, change);
const ZWJ = "\u200D";

function withoutStrayJoiners(cluster: string): string {
  const chars = [...cluster];
  return chars.filter((char, i) => char !== ZWJ || (i > 0 && isPictographic(chars[i + 1] ?? ""))).join("");
}

function cleanOnce(text: string): string {
  const shown = withoutUnseen(inBasicPlane(withoutUnseen(text), (run) => run.normalize("NFC").toLocaleUpperCase().normalize("NFC")));
  let kept = "";
  for (const cluster of graphemeClusters(shown).filter(startsCluster).filter(drawsSomething).map(withoutStrayJoiners).map(withoutRepeatedInvisibles).slice(0, TILE_LETTERS_MAX)) {
    if (kept.length + cluster.length > TILE_LETTERS_MAX_LENGTH) break;
    kept += cluster;
  }
  return kept;
}

const INPUT_WINDOW = TILE_LETTERS_MAX_LENGTH * 64;

function withinWindow(input: string): string {
  if (input.length <= INPUT_WINDOW) return input;
  const last = input.charCodeAt(INPUT_WINDOW - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? INPUT_WINDOW - 1 : INPUT_WINDOW;
  const clusters = graphemeClusters(input.slice(0, end));
  clusters.pop();
  return clusters.join("");
}

export function cleanTileLetters(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let kept = cleanOnce(withinWindow(input));
  for (let pass = 0; pass < 4; pass++) {
    const again = cleanOnce(kept);
    if (again === kept) break;
    kept = again;
  }
  return kept || null;
}

export const tileLettersOf = (t: { url: string; title: string; customTitle?: string | null; tileLetters?: string | null }): string =>
  (t.tileLetters && cleanTileLetters(t.tileLetters)) || tileLetterOf(t.url, t.customTitle ?? t.title);
