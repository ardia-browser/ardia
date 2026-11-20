import type { BrowserState } from "../browser/store";
import type { SplitView } from "../browser/types";
import { MAX_SPLIT_PANES, splitOf, splitTabIds } from "../splits/splits";
import { eligibleKind, isEligibleTab, shownPage } from "./automationWindows";
import type { MethodSpec } from "./socketCatalog";
import { id, ids, obj, oneOf, TAB, text, WINDOW } from "./socketSchema";
import { expect, now, tabOf, windowOf } from "./socketTargets";
import { openableUrl } from "./workspaceOps";
import { OpError } from "./workspaceTargets";

const ORIENTATIONS = ["horizontal", "vertical"] as const;

export function splitRow(s: BrowserState, v: SplitView) {
  return {
    id: v.id,
    window: v.windowId,
    orientation: v.orientation,
    tabs: splitTabIds(v),
    panes: v.slots.map((slot) => ("tabId" in slot ? { size: slot.size, tab: slot.tabId } : { size: slot.size, stack: slot.stack, stackSizes: slot.stackSizes })),
  };
}

function splitArg(value: unknown): SplitView {
  const s = now();
  const v = typeof value === "string" && Object.hasOwn(s.splits, value) ? s.splits[value] : undefined;
  if (!v || !eligibleKind(s, v.windowId)) throw new OpError("no_window", `There's no split ${String(value)}.`);
  return v;
}

function listSplits(params: Record<string, unknown>) {
  const s = now();
  const windowId = params.window !== undefined ? windowOf(params.window).id : null;
  return Object.values(s.splits).filter((v) => eligibleKind(s, v.windowId) && (!windowId || v.windowId === windowId)).map((v) => splitRow(s, v));
}

function createSplit(params: Record<string, unknown>) {
  const tabs = (params.tabs as string[]).map((t) => tabOf(t));
  if (new Set(tabs.map((t) => t.windowId)).size !== 1) throw new OpError("bad_request", "A split's tabs are in one window.");
  if (new Set(tabs.map((t) => t.id)).size !== tabs.length) throw new OpError("bad_request", "A tab can be in a split once.");
  const already = tabs.find((t) => splitOf(now(), t.id));
  if (already) throw new OpError("bad_request", `Tab ${already.id} is already in split ${splitOf(now(), already.id)!.id}.`);
  const made = now().createSplit(tabs.map((t) => t.id), params.orientation as SplitView["orientation"] | undefined);
  expect(!!made && !!now().splits[made], "the split wasn't made.");
  return splitRow(now(), now().splits[made]!);
}

function resize(params: Record<string, unknown>) {
  const v = splitArg(params.split);
  const sizes = params.sizes as number[];
  if (sizes.length !== v.slots.length) throw new OpError("bad_request", `Split ${v.id} has ${v.slots.length} panes.`);
  const total = sizes.reduce((a, b) => a + b, 0);
  const shares = sizes.map((n) => n / total);
  if (!shares.every((n) => Number.isFinite(n) && n > 0)) throw new OpError("bad_request", "sizes must be positive numbers whose shares are all above zero.");
  now().updateSplit(v.id, { sizes: shares });
  return splitRow(now(), now().splits[v.id]!);
}

function setOrientation(params: Record<string, unknown>) {
  const v = splitArg(params.split);
  if (v.orientation !== params.orientation) now().toggleSplitOrientation(v.id);
  return splitRow(now(), now().splits[v.id]!);
}

function peekList() {
  const s = now();
  return Object.values(s.peeks).flatMap((p) => {
    const t = s.tabs[p.tabId];
    if (!t || !isEligibleTab(s, p.sourceId)) return [];
    return [{ source: p.sourceId, tab: p.tabId, window: t.windowId, ...shownPage(t) }];
  });
}

function openPeek(params: Record<string, unknown>) {
  const source = tabOf(params.tab);
  const url = openableUrl(params.url as string);
  if (typeof url !== "string" || !url) throw new OpError("refused", typeof url === "string" ? "Peek shows a page, not a New Tab." : url.error);
  const tab = now().openPeek(source.id, url);
  expect(!!tab && now().peeks[source.id]?.tabId === tab, "the peek didn't open.");
  return { source: source.id, tab };
}

export const SPLIT_METHODS: MethodSpec[] = [
  { name: "splits.list", mutates: false, description: "Split views and their panes", params: obj({ window: WINDOW }), result: "[split]", run: listSplits },
  { name: "splits.create", mutates: true, description: "Show tabs of one window side by side", params: obj({ tabs: { ...ids(`2 to ${MAX_SPLIT_PANES} tab ids of one window`, MAX_SPLIT_PANES), minItems: 2 }, orientation: oneOf(ORIENTATIONS, "Side by side (horizontal) or stacked (vertical)") }, ["tabs"]), result: "split", run: createSplit },
  {
    name: "splits.separate",
    mutates: true,
    description: "End a split view; its tabs stay open",
    params: obj({ split: id("A split id from splits.list") }, ["split"]),
    result: "{ok}",
    run: (p) => {
      const v = splitArg(p.split);
      now().separateSplit(v.id);
      expect(!now().splits[v.id], `split ${v.id} is still there.`);
      return { ok: true };
    },
  },
  {
    name: "splits.removeTab",
    mutates: true,
    description: "Take one tab out of its split view",
    params: obj({ tab: TAB }, ["tab"]),
    result: "{ok}",
    run: (p) => {
      const t = tabOf(p.tab);
      if (!splitOf(now(), t.id)) throw new OpError("bad_request", `Tab ${t.id} isn't in a split.`);
      now().removeTabFromSplit(t.id);
      expect(!splitOf(now(), t.id), `tab ${t.id} is still in its split.`);
      return { ok: true };
    },
  },
  { name: "splits.resize", mutates: true, description: "Set the panes' sizes (any positive numbers; they're made proportional)", params: obj({ split: id("A split id"), sizes: { type: "array", items: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000 }, minItems: 2, maxItems: 4, description: "One size per pane" } }, ["split", "sizes"]), result: "split", run: resize },
  {
    name: "splits.flip",
    mutates: true,
    description: "Reverse the panes' order",
    params: obj({ split: id("A split id") }, ["split"]),
    result: "split",
    run: (p) => {
      const v = splitArg(p.split);
      now().flipSplit(v.id);
      return splitRow(now(), now().splits[v.id]!);
    },
  },
  { name: "splits.setOrientation", mutates: true, description: "Side by side or stacked", params: obj({ split: id("A split id"), orientation: oneOf(ORIENTATIONS, "horizontal or vertical") }, ["split", "orientation"]), result: "split", run: setOrientation },
  { name: "peek.list", mutates: false, description: "Open peeks: the tab each was opened from and the page it shows", params: obj({}), result: "[{source, tab, window, url, title}]", run: peekList },
  { name: "peek.open", mutates: true, description: "Peek a page over a tab", params: obj({ tab: TAB, url: text("The page to peek") }, ["tab", "url"]), result: "{source, tab}", run: openPeek },
  {
    name: "peek.close",
    mutates: true,
    description: "Close the peek over a tab",
    params: obj({ tab: TAB }, ["tab"]),
    result: "{ok}",
    run: (p) => {
      const t = tabOf(p.tab);
      if (!now().peeks[t.id]) throw new OpError("bad_request", `Tab ${t.id} has no peek.`);
      now().closePeek(t.id);
      return { ok: true };
    },
  },
  {
    name: "peek.toTab",
    mutates: true,
    description: "Keep the peek shown in a window as a tab",
    params: obj({ window: WINDOW }, ["window"]),
    result: "{tab}",
    run: (p) => {
      const w = windowOf(p.window);
      const tab = now().peekToTab(w.id, { activate: true });
      expect(!!tab, `window ${w.id} has no peek shown.`);
      return { tab };
    },
  },
];
