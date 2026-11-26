export type MenuBox = { left: number; top: number; right: number; width: number };
export type MenuAnchor = { x: number; y: number } | { row: { top: number }; parent: MenuBox };

export const MENU_MARGIN = 8;
export const SUBMENU_OVERLAP = 4;
export const SUBMENU_LIFT = 5;

export function placeMenu(size: { width: number; height: number }, anchor: MenuAnchor, viewport: { width: number; height: number }) {
  let left: number;
  let top: number;
  if ("row" in anchor) {
    left = anchor.parent.right - SUBMENU_OVERLAP;
    top = anchor.row.top - SUBMENU_LIFT;
    if (left + size.width > viewport.width - MENU_MARGIN) left = anchor.parent.left - size.width + SUBMENU_OVERLAP;
  } else {
    left = anchor.x;
    top = anchor.y;
  }
  left = Math.max(MENU_MARGIN, Math.min(left, viewport.width - size.width - MENU_MARGIN));
  top = Math.max(MENU_MARGIN, Math.min(top, viewport.height - size.height - MENU_MARGIN));
  return { left, top };
}
