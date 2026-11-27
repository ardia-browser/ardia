import type { Settings } from "../../state/settings/settings";

type Choice<V> = { value: V; title: string; caption: string };

export const TAB_SWITCHER_ORDERS: readonly Choice<Settings["tabSwitcherOrder"]>[] = [
  { value: "recent", title: "Recent tabs", caption: "Most recently used first; let go to switch, like Arc and Dia." },
  { value: "inOrder", title: "In order", caption: "Down the tab list, like Chrome." },
];

export const TAB_SWITCHER_VIEWS: readonly Choice<Settings["tabSwitcherView"]>[] = [
  { value: "thumbnails", title: "Page previews", caption: "A row of page pictures." },
  { value: "compactList", title: "Compact list", caption: "Titles and sites, one per line." },
  { value: "none", title: "None", caption: "Switches without showing anything." },
];

export type CtrlTabAnswer = "switcher" | "step";

export const CTRL_TAB_ANSWERS: readonly Choice<CtrlTabAnswer>[] = [
  { value: "step", title: "Step through tabs", caption: "Goes one tab down the list, like Chrome." },
  { value: "switcher", title: "Recent tabs switcher", caption: "Shows recent tabs; let go to switch, like Arc." },
];

export function ctrlTabAnswerOf({ tabSwitcherOrder, tabSwitcherView }: Pick<Settings, "tabSwitcherOrder" | "tabSwitcherView">): CtrlTabAnswer | null {
  if (tabSwitcherOrder === "recent") return "switcher";
  return tabSwitcherView === "none" ? "step" : null;
}

export function ctrlTabAnswerPatch(answer: CtrlTabAnswer, view: Settings["tabSwitcherView"]): Pick<Settings, "tabSwitcherOrder" | "tabSwitcherView"> {
  return answer === "step" ? { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" } : { tabSwitcherOrder: "recent", tabSwitcherView: view === "none" ? "thumbnails" : view };
}
