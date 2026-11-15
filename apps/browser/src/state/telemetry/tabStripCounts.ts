let groupToggles = 0;
let textOnlyRows = 0;

export function noteTabStripGroupToggle() {
  groupToggles++;
}

export function noteTextOnlyRow() {
  textOnlyRows++;
}

export function takeTabStripCounts() {
  const taken = { tab_strip_group_toggles: groupToggles, pinned_rows_made_text_only: textOnlyRows };
  groupToggles = 0;
  textOnlyRows = 0;
  return taken;
}
