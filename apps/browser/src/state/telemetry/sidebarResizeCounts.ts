let resizes = 0;

export function noteSidebarResize() {
  resizes++;
}

export function takeSidebarResizeCounts() {
  const taken = { sidebar_resizes: resizes };
  resizes = 0;
  return taken;
}
