let groupToggles = 0;
let textOnlyRows = 0;
let compactLayouts = 0;
let edgeScrollDrags = 0;
let revealsAfterPress = 0;
let mostTabs = 0;
let heldCloses = 0;
let mostTitledTabs = 0;

export function noteTabStripGroupToggle() {
  groupToggles++;
}

export function noteTextOnlyRow() {
  textOnlyRows++;
}

export function noteTabStripCompact() {
  compactLayouts++;
}

export function noteTabStripEdgeScroll() {
  edgeScrollDrags++;
}

export function noteTabStripRevealAfterPress() {
  revealsAfterPress++;
}

export function noteTabStripOverflow(tabs: number) {
  mostTabs = Math.max(mostTabs, tabs);
}

export function noteTabStripHeldClose() {
  heldCloses++;
}

export function noteTabStripTitledTabs(tabs: number) {
  mostTitledTabs = Math.max(mostTitledTabs, tabs);
}

export function takeTabStripCounts() {
  const taken = {
    tab_strip_group_toggles: groupToggles,
    pinned_rows_made_text_only: textOnlyRows,
    tab_strip_compact_layouts: compactLayouts,
    tab_strip_edge_scroll_drags: edgeScrollDrags,
    tab_strip_reveals_after_press: revealsAfterPress,
    tab_strip_most_tabs: mostTabs,
    tab_strip_held_closes: heldCloses,
    tab_strip_most_titled_tabs: mostTitledTabs,
  };
  groupToggles = 0;
  textOnlyRows = 0;
  compactLayouts = 0;
  edgeScrollDrags = 0;
  revealsAfterPress = 0;
  mostTabs = 0;
  heldCloses = 0;
  mostTitledTabs = 0;
  return taken;
}
