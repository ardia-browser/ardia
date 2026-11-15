let copies = 0;
let whilePending = 0;
let selectionKeys = 0, selectedTabs = 0, plainSelectionKeys = 0;

export function noteUrlCopied(firstPagePending: boolean) {
  copies++;
  if (firstPagePending) whilePending++;
}

export function noteSelectionCopiedByKey(tabs: number, plainCopy: boolean) {
  selectionKeys++;
  selectedTabs += tabs;
  if (plainCopy) plainSelectionKeys++;
}

export function takeUrlCopyCounts() {
  const taken = { url_copies: copies, url_copies_while_pending: whilePending, selection_copy_keys: selectionKeys, selection_copy_key_tabs: selectedTabs, selection_plain_copy_keys: plainSelectionKeys };
  copies = 0;
  whilePending = 0;
  selectionKeys = 0;
  selectedTabs = 0;
  plainSelectionKeys = 0;
  return taken;
}
