import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

let opens = 0;
let noArticle = 0;
let checked = 0;
let withoutArticle = 0;

export const noteReaderOpened = (consent?: ConsentToken | null) => countFor(consent, () => void opens++, { reader_opens: 1 });
export const noteReaderNoArticle = (consent?: ConsentToken | null) => countFor(consent, () => void noArticle++, { reader_no_article: 1 });

export function noteReaderCheck(readerable: boolean, consent?: ConsentToken | null) {
  countFor(consent, () => void (checked++, !readerable && withoutArticle++), { reader_pages_checked: 1, reader_pages_without_article: +!readerable });
}

export function takeReaderCounts() {
  const taken = { reader_opens: opens, reader_no_article: noArticle, reader_pages_checked: checked, reader_pages_without_article: withoutArticle };
  opens = 0;
  noArticle = 0;
  checked = 0;
  withoutArticle = 0;
  return taken;
}
