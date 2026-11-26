import { hostOf, urlForDisplay } from "./omnibox.ts";
import type { SuggestionSource } from "./suggestion.ts";

export function displayUrl(url: string): string {
  return urlForDisplay(url).replace(/\/$/, "");
}

export const documentKey = (url: string) => {
  const at = url.indexOf("#");
  return (at < 0 ? url : url.slice(0, at)).replace(/\/$/, "");
};

export const routeOf = (url: string) => {
  const at = url.indexOf("#");
  return at >= 0 && (url.startsWith("#/", at) || url.startsWith("#!/", at)) ? url.slice(at) : "";
};

export const pageKey = (url: string) => documentKey(url) + routeOf(url);

export const withRootSlash = (url: string) => url.replace(/^(https?:\/\/[^/?#]*)(?=[?#]|$)/i, "$1/");

export type PageText = {
  url: string;
  key: string;
  document?: string;
  shown: string;
  shownClipped?: boolean;
  shownLower: string;
  titleLower: string;
  titleWords: string;
  shownWords?: string;
  shownBlank?: boolean;
  host?: string;
  origin?: string | null;
  hostLower?: string;
};

export const pageTexts = new WeakMap<object, PageText>();

const logVisitsOf: number[] = [];
export const logVisits = (visits: number) => (visits >= 0 && visits < 1024 && (visits | 0) === visits ? (logVisitsOf[visits] ??= Math.log2(1 + visits) * 8) : Math.log2(1 + visits) * 8);

const NOT_WORD = /[^a-z0-9]+/g;
const PLAIN_WORDS = /^[a-z0-9]+(?: [a-z0-9]+)*$/;
const wordsOf = (lower: string) => (PLAIN_WORDS.test(lower) ? ` ${lower}` : ` ${lower}`.replace(NOT_WORD, " "));
export const shownWordsOf = (t: PageText) => (t.shownWords ??= wordsOf(t.shownLower));

const MAX_INDEXED_SHOWN = 2048;
const MAX_INDEXED_TITLE = 512;

function clipIndexed(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

export function pageText(row: { url: string; title: string }): PageText {
  let text = pageTexts.get(row);
  if (!text) {
    const rawShown = displayUrl(row.url);
    const shownClipped = rawShown.length > MAX_INDEXED_SHOWN;
    const shown = shownClipped ? clipIndexed(rawShown, MAX_INDEXED_SHOWN) : rawShown;
    const shownLower = shown.toLowerCase();
    const titleLower = clipIndexed(row.title, MAX_INDEXED_TITLE).toLowerCase();
    const document = documentKey(row.url);
    const route = routeOf(row.url);
    text = { url: row.url, key: document + route, shown, shownLower, titleLower, titleWords: wordsOf(titleLower) };
    if (shownClipped) text.shownClipped = true;
    if (route) text.document = document;
    pageTexts.set(row, text);
  }
  return text;
}

const renamedTexts = new WeakMap<object, { listed: PageText | undefined; text: PageText }>();

export function tabPageText(row: Pick<SuggestionSource["tabs"][number], "url" | "title" | "customTitle">, listed?: PageText): PageText {
  const text = pageText(row);
  if (!row.customTitle) return text;
  const kept = renamedTexts.get(row);
  if (kept && kept.listed === listed) return kept.text;
  const titles = [row.customTitle.toLowerCase(), text.titleLower];
  if (listed && listed.titleLower !== text.titleLower) titles.push(listed.titleLower);
  const titleLower = titles.join("\n");
  const renamed = { ...(listed ?? text), titleLower, titleWords: wordsOf(titleLower) };
  renamedTexts.set(row, { listed, text: renamed });
  return renamed;
}

export const hostOfPage = (t: PageText) => (t.host ??= hostOf(t.url));
export const hostPart = (shown: string) => /^[^/?#]*/.exec(shown)![0];
export const hostLowerOfPage = (t: PageText) => (t.hostLower ??= hostPart(t.shownLower));
export const originOfPage = (t: PageText) => (t.origin === undefined ? (t.origin = /^https?:\/\/[^/?#]+/i.exec(t.url)?.[0] ?? null) : t.origin);
