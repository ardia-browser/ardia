import type { PageKind, SearchHit } from "../shared/protocol";

const SPECIAL: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ı: "i", þ: "th", ð: "d", ŧ: "t", ħ: "h" };
const MARKS = /\p{M}+/gu;
const WORD = /[\p{L}\p{N}]+/gu;

function foldChunk(text: string): string {
  return text
    .normalize("NFKD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(/[ßæœøłđıþðŧħ]/g, (c) => SPECIAL[c] ?? c);
}

export function fold(text: string): string {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  return ascii ? text.toLowerCase() : foldChunk(text);
}

export function tokens(text: string): string[] {
  return fold(text).match(WORD) ?? [];
}

function foldWithMap(text: string, limit: number): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  const end = Math.min(text.length, limit);
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      folded += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : text[i];
      map.push(i);
      continue;
    }
    let ch = text[i]!;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < end) ch += text[i + 1]!;
    const f = foldChunk(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    if (ch.length === 2) i++;
  }
  return { folded, map };
}

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

export type IndexInput = {
  workspace: string;
  page: string;
  title: string;
  icon: string;
  kind: PageKind;
  path: string[];
  updatedAt: number;
  live: boolean;
};

type Entry = IndexInput & {
  key: string;
  text: string;
  foldedTitle: string;
  foldedText: string | null;
  titleTokens: Set<string>;
  textTokens: Set<string>;
};

const TITLE = 1;
const TEXT = 2;
const SNIPPET_MAX = 160;
const SNIPPET_SCAN = 200_000;

export const keyOf = (workspace: string, page: string) => `${workspace}/${page}`;

export class SearchIndex {
  private entries = new Map<string, Entry>();
  private postings = new Map<string, Map<string, number>>();
  private sorted: string[] | null = null;

  size(): number {
    return this.entries.size;
  }

  has(workspace: string, page: string): boolean {
    return this.entries.has(keyOf(workspace, page));
  }

  upsert(input: IndexInput, text?: string): void {
    const key = keyOf(input.workspace, input.page);
    const old = this.entries.get(key);
    const nextText = text ?? old?.text ?? "";
    const titleTokens = new Set(tokens(input.title));
    const textTokens = old && text === undefined ? old.textTokens : new Set(tokens(nextText));
    const entry: Entry = { ...input, key, text: nextText, foldedTitle: fold(input.title.trim()), foldedText: old && text === undefined ? old.foldedText : null, titleTokens, textTokens };
    if (old) this.unpost(old);
    this.entries.set(key, entry);
    this.post(entry);
  }

  setText(workspace: string, page: string, text: string): boolean {
    const old = this.entries.get(keyOf(workspace, page));
    if (!old) return false;
    if (old.text === text) return true;
    this.upsert(old, text);
    return true;
  }

  textOf(workspace: string, page: string): string | null {
    return this.entries.get(keyOf(workspace, page))?.text ?? null;
  }

  remove(workspace: string, page: string): void {
    const key = keyOf(workspace, page);
    const old = this.entries.get(key);
    if (!old) return;
    this.unpost(old);
    this.entries.delete(key);
  }

  removeWorkspace(workspace: string): void {
    for (const entry of [...this.entries.values()]) if (entry.workspace === workspace) this.remove(entry.workspace, entry.page);
  }

  pagesOf(workspace: string): string[] {
    const out: string[] = [];
    for (const entry of this.entries.values()) if (entry.workspace === workspace) out.push(entry.page);
    return out;
  }

  recent(limit: number, workspace?: string): SearchHit[] {
    return [...this.entries.values()]
      .filter((e) => e.live && (!workspace || e.workspace === workspace))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((e) => this.hit(e, 0, ""));
  }

  search(query: string, options: { workspace?: string; limit?: number; titlesOnly?: boolean } = {}): SearchHit[] {
    const limit = Math.max(1, Math.min(200, options.limit ?? 20));
    const terms = [...new Set(tokens(query))];
    if (terms.length === 0) return [];
    const phrase = fold(query.trim()).replace(/\s+/g, " ");
    const flagsWanted = options.titlesOnly ? TITLE : TITLE | TEXT;
    let scores: Map<string, number> | null = null;
    for (const term of terms) {
      const termScores = new Map<string, number>();
      for (const token of this.matching(term)) {
        const posting = this.postings.get(token);
        if (!posting) continue;
        const exact = token === term;
        const closeness = term.length / token.length;
        for (const [key, flags] of posting) {
          if (!(flags & flagsWanted)) continue;
          let s = 0;
          if (flags & TITLE) s = Math.max(s, exact ? 10 : 5 + 3 * closeness);
          if (flags & TEXT && !options.titlesOnly) s = Math.max(s, exact ? 3 : 1 + closeness);
          const before = termScores.get(key) ?? 0;
          if (s > before) termScores.set(key, s);
        }
      }
      if (scores === null) scores = termScores;
      else {
        const next = new Map<string, number>();
        for (const [key, s] of scores) {
          const add = termScores.get(key);
          if (add !== undefined) next.set(key, s + add);
        }
        scores = next;
      }
      if (scores.size === 0) break;
    }
    const ranked: { entry: Entry; score: number }[] = [];
    for (const [key, s] of scores ?? []) {
      const entry = this.entries.get(key);
      if (!entry || !entry.live || (options.workspace && entry.workspace !== options.workspace)) continue;
      let score = s;
      const title = entry.foldedTitle;
      if (entry.titleTokens.size) score += 1 / entry.titleTokens.size;
      if (title === phrase) score += 20;
      else if (title.startsWith(phrase)) score += isWordChar(title[phrase.length]) ? 3 : 8;
      else if (phrase.length > 1) {
        const at = title.indexOf(phrase);
        if (at > 0) score += !isWordChar(title[at - 1]) && !isWordChar(title[at + phrase.length]) ? 4 : 1;
      }
      ranked.push({ entry, score });
    }
    if (ranked.length < limit && (phrase.length >= 3 || (phrase.length >= 1 && /[^\u0000-\u024f]/.test(phrase)))) {
      const seen = new Set(ranked.map((r) => r.entry.key));
      for (const entry of this.entries.values()) {
        if (ranked.length >= limit * 3) break;
        if (seen.has(entry.key) || !entry.live || (options.workspace && entry.workspace !== options.workspace)) continue;
        if (entry.foldedTitle.includes(phrase)) ranked.push({ entry, score: 2 });
        else if (!options.titlesOnly && entry.text.length > 0 && this.foldedTextOf(entry).includes(phrase)) ranked.push({ entry, score: 0.5 });
      }
    }
    ranked.sort((a, b) => {
      const qa = Math.round(a.score * 4);
      const qb = Math.round(b.score * 4);
      return qb - qa || b.entry.updatedAt - a.entry.updatedAt || (a.entry.key < b.entry.key ? -1 : 1);
    });
    return ranked.slice(0, limit).map(({ entry, score }) => this.hit(entry, score, options.titlesOnly ? "" : snippet(entry.text, terms, phrase)));
  }

  private hit(entry: Entry, score: number, snip: string): SearchHit {
    return { workspace: entry.workspace, page: entry.page, title: entry.title, icon: entry.icon, path: entry.path, snippet: snip, score, updatedAt: entry.updatedAt };
  }

  private foldedTextOf(entry: Entry): string {
    entry.foldedText ??= fold(entry.text.slice(0, SNIPPET_SCAN));
    return entry.foldedText;
  }

  private matching(term: string): string[] {
    const sorted = this.sortedTokens();
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < term) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < sorted.length && sorted[i]!.startsWith(term); i++) {
      out.push(sorted[i]!);
      if (out.length > 5000) break;
    }
    return out;
  }

  private sortedTokens(): string[] {
    if (!this.sorted) this.sorted = [...this.postings.keys()].sort();
    return this.sorted;
  }

  private post(entry: Entry) {
    const add = (token: string, flag: number) => {
      let posting = this.postings.get(token);
      if (!posting) {
        posting = new Map();
        this.postings.set(token, posting);
        this.sorted = null;
      }
      posting.set(entry.key, (posting.get(entry.key) ?? 0) | flag);
    };
    for (const t of entry.titleTokens) add(t, TITLE);
    for (const t of entry.textTokens) add(t, TEXT);
  }

  private unpost(entry: Entry) {
    for (const t of new Set([...entry.titleTokens, ...entry.textTokens])) {
      const posting = this.postings.get(t);
      if (!posting) continue;
      posting.delete(entry.key);
      if (posting.size === 0) {
        this.postings.delete(t);
        this.sorted = null;
      }
    }
  }
}

export function snippet(text: string, terms: string[], phrase: string): string {
  if (!text) return "";
  const { folded, map } = foldWithMap(text, SNIPPET_SCAN);
  let best = -1;
  let bestLen = 0;
  const consider = (needle: string, wordStart: boolean) => {
    if (!needle) return;
    let from = 0;
    for (;;) {
      const at = folded.indexOf(needle, from);
      if (at < 0) return;
      if (!wordStart || !isWordChar(folded[at - 1])) {
        if (best < 0 || at < best) {
          best = at;
          bestLen = needle.length;
        }
        return;
      }
      from = at + 1;
    }
  };
  if (phrase.includes(" ")) consider(phrase, true);
  if (best < 0) for (const term of terms) consider(term, true);
  if (best < 0) consider(phrase, false);
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  if (best < 0) {
    const head = clean(text.slice(0, SNIPPET_MAX * 2));
    return head.length <= SNIPPET_MAX ? head : head.slice(0, SNIPPET_MAX - 1).replace(/\s+\S*$/, "") + "…";
  }
  const startOrig = map[best] ?? 0;
  const endOrig = (map[Math.min(map.length - 1, best + bestLen - 1)] ?? startOrig) + 1;
  let start = Math.max(0, startOrig - 50);
  if (start > 0) {
    const space = text.lastIndexOf(" ", startOrig - 1);
    const lineBreak = text.lastIndexOf("\n", startOrig - 1);
    const boundary = Math.max(space, lineBreak);
    if (boundary >= start - 10 && boundary >= 0) start = boundary + 1;
  }
  const window = text.slice(start, start + SNIPPET_MAX * 2);
  let body = clean(window);
  const prefix = start > 0 ? "…" : "";
  const room = SNIPPET_MAX - prefix.length;
  let suffix = "";
  if (body.length > room || start + window.length < text.length) {
    if (body.length > room - 1) {
      body = body.slice(0, room - 1);
      const cut = body.replace(/\s+\S*$/, "");
      if (cut.length > Math.max(20, endOrig - start)) body = cut;
    }
    suffix = "…";
  }
  const out = prefix + body + suffix;
  return out.length <= SNIPPET_MAX ? out : out.slice(0, SNIPPET_MAX - 1) + "…";
}
