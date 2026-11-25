let popupsOpenedAsTabs = 0;
let shiftClickWindowPeeks = 0;

export function notePopupOpenedAsTab() {
  popupsOpenedAsTabs++;
}

export function notePeekFromShiftWindow() {
  shiftClickWindowPeeks++;
}

export function takePopupTabCounts() {
  const taken = { popups_opened_as_tabs: popupsOpenedAsTabs, shift_click_window_peeks: shiftClickWindowPeeks };
  popupsOpenedAsTabs = 0;
  shiftClickWindowPeeks = 0;
  return taken;
}
