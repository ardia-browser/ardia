let popupsOpenedAsTabs = 0;

export function notePopupOpenedAsTab() {
  popupsOpenedAsTabs++;
}

export function takePopupTabCounts() {
  const taken = { popups_opened_as_tabs: popupsOpenedAsTabs };
  popupsOpenedAsTabs = 0;
  return taken;
}
