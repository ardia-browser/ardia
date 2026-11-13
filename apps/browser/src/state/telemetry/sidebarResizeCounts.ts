let resizes = 0;
let fieldMoves = 0;

export function noteSidebarResize() {
  resizes++;
}

export function noteSidebarFieldMoved() {
  fieldMoves++;
}

export function takeSidebarResizeCounts() {
  const taken = { sidebar_resizes: resizes, sidebar_field_moves: fieldMoves };
  resizes = 0;
  fieldMoves = 0;
  return taken;
}
