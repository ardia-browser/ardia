import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

let toTop = 0;
let toSidebar = 0;

export function noteTabLayoutSwitch(to: "sidebar" | "top", consent?: ConsentToken | null) {
  const field = to === "top" ? "tab_layout_switches_to_top" : "tab_layout_switches_to_sidebar";
  countFor(consent, () => void (to === "top" ? toTop++ : toSidebar++), { [field]: 1 });
}

export function takeTabLayoutCounts() {
  const taken = { tab_layout_switches_to_top: toTop, tab_layout_switches_to_sidebar: toSidebar };
  toTop = 0;
  toSidebar = 0;
  return taken;
}
