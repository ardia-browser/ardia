import type { Selection } from "./inline";

export const REVERT_WINDOW_MS = 3000;

type RevertWatch = {
  first: string | null;
  firstAt: number;
  heard: string;
  typedOnly: boolean;
  lost: { at: number; text: string } | null;
  shown: string;
  spent: boolean;
};

type RevertRead = { text: string; watch: RevertWatch; caret: number | null; restored: { at: number; text: string } | null };

export const freshRevertWatch = (): RevertWatch => ({ first: null, firstAt: 0, heard: "", typedOnly: true, lost: null, shown: "", spent: false });

export const wroteOverField = (watch: RevertWatch): RevertWatch => ({ ...watch, lost: null, typedOnly: false });

const typedOneMore = (from: string, to: string) => to.length === from.length + 1 && to.startsWith(from);

const plain = (text: string) => /^[\x20-\x7e]*$/.test(text);

const caretAtEnd = (caret: Selection, ...texts: string[]) => caret.start === caret.end && texts.some((t) => caret.end === t.length);

const withLost = (native: string, lost: { at: number; text: string }) => native.slice(0, lost.at) + lost.text + native.slice(lost.at);

export function readNativeText(watch: RevertWatch, next: string, caret: Selection, now: number): RevertRead {
  const typed = caretAtEnd(caret, watch.heard, next) && typedOneMore(watch.heard, next);
  const heard = { ...watch, heard: next };
  if (watch.lost) {
    if (!typed || typedOneMore(watch.shown, next)) return { text: next, watch: { ...heard, lost: null, typedOnly: false }, caret: null, restored: null };
    const text = withLost(next, watch.lost);
    return { text, watch: { ...heard, shown: text }, caret: text.length, restored: null };
  }
  if (watch.first === null) return { text: next, watch: { ...heard, first: next, firstAt: now, typedOnly: watch.typedOnly && typed }, caret: null, restored: null };
  const first = watch.first;
  const reverted =
    !watch.spent &&
    watch.typedOnly &&
    now - watch.firstAt <= REVERT_WINDOW_MS &&
    caretAtEnd(caret, watch.heard, next) &&
    watch.heard.length > first.length &&
    watch.heard.startsWith(first) &&
    next.length === first.length + 1 &&
    next.startsWith(first) &&
    !(watch.heard.length > next.length && watch.heard.startsWith(next)) &&
    plain(watch.heard) &&
    plain(next);
  if (!reverted) return { text: next, watch: { ...heard, typedOnly: watch.typedOnly && typed }, caret: null, restored: null };
  const lost = { at: first.length, text: watch.heard.slice(first.length) };
  const text = withLost(next, lost);
  return { text, watch: { ...heard, lost, shown: text, spent: true }, caret: text.length, restored: lost };
}
