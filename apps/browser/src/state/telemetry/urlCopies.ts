const NONE = { url_copies: 0, url_copies_while_pending: 0, selection_copy_keys: 0, selection_copy_key_tabs: 0, selection_plain_copy_keys: 0 };
let counts = { ...NONE };

export function noteUrlCopied(firstPagePending: boolean) {
  counts.url_copies++;
  if (firstPagePending) counts.url_copies_while_pending++;
}

export function noteSelectionCopiedByKey(tabs: number, plainCopy: boolean) {
  counts.selection_copy_keys++;
  counts.selection_copy_key_tabs += tabs;
  if (plainCopy) counts.selection_plain_copy_keys++;
}

export function takeUrlCopyCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
