import type { CornerRadii } from "../../hostExtensionView";

const CORNERS = [["upperLeft", "TopLeft"], ["upperRight", "TopRight"], ["lowerRight", "BottomRight"], ["lowerLeft", "BottomLeft"]] as const;

export function clipRadii(node: HTMLElement): CornerRadii {
  const radii: CornerRadii = { upperLeft: 0, upperRight: 0, lowerRight: 0, lowerLeft: 0 };
  const box = node.getBoundingClientRect();
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const outer = parent.getBoundingClientRect();
    const insets = { upperLeft: [box.left - outer.left, box.top - outer.top], upperRight: [outer.right - box.right, box.top - outer.top], lowerRight: [outer.right - box.right, outer.bottom - box.bottom], lowerLeft: [box.left - outer.left, outer.bottom - box.bottom] };
    let rounded = false;
    for (const [corner, css] of CORNERS) {
      const radius = parseFloat(style.getPropertyValue(`border-${css.replace(/([A-Z])/g, "-$1").toLowerCase().slice(1)}-radius`)) || 0;
      if (radius <= 0) continue;
      rounded = true;
      const inset = Math.max(...insets[corner]);
      if (Math.min(...insets[corner]) > -0.5 && inset <= 2) radii[corner] = Math.max(0, radius - Math.max(0, inset));
    }
    if (rounded) return radii;
  }
  return radii;
}
