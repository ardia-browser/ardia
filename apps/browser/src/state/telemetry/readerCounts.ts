let opens = 0;
let noArticle = 0;
let checked = 0;
let withoutArticle = 0;

export const noteReaderOpened = () => void opens++;
export const noteReaderNoArticle = () => void noArticle++;

export function noteReaderCheck(readerable: boolean) {
  checked++;
  if (!readerable) withoutArticle++;
}

export function takeReaderCounts() {
  const taken = { reader_opens: opens, reader_no_article: noArticle, reader_pages_checked: checked, reader_pages_without_article: withoutArticle };
  opens = 0;
  noArticle = 0;
  checked = 0;
  withoutArticle = 0;
  return taken;
}
