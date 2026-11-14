const APP_REGION = "-webkit-app-region";
const REGION_MARK = "ardiaDragRegion";
const SYSTEM_REGION = "[data-ardia-drag-region='system']";
const PASS_DELAY_MS = 120;
const BAR_HEIGHT = 64;
export const INTERACTIVE = "input, textarea, select, button, a[href], webview, iframe, video, audio, [contenteditable='true'], [role='button'], [role='link'], [tabindex], [data-ardia-stays-put]";
const PLAIN_CURSORS = new Set(["auto", "default", ""]);
const SCROLLING = new Set(["auto", "scroll"]);
const WATCHED_ATTRIBUTES = ["class", "style", "tabindex", "role", "href", "contenteditable", "data-ardia-stays-put", "data-ardia-drag-region"];

type Tracked = { region: HTMLElement; covers: Set<HTMLElement> };
type DocumentTracker = { regions: Set<Tracked>; observer: MutationObserver; resize: () => void; timer: ReturnType<typeof setTimeout> | null };

const trackers = new WeakMap<Document, DocumentTracker>();
const claims = new WeakMap<HTMLElement, number>();

const isElement = (node: Element): node is HTMLElement => node.nodeType === 1 && "style" in node && "dataset" in node;

function claim(element: HTMLElement) {
  const count = claims.get(element) ?? 0;
  claims.set(element, count + 1);
  if (!count) element.style.setProperty(APP_REGION, "no-drag");
}

function release(element: HTMLElement) {
  const count = (claims.get(element) ?? 1) - 1;
  if (count > 0) return void claims.set(element, count);
  claims.delete(element);
  if (!element.dataset[REGION_MARK]) element.style.removeProperty(APP_REGION);
}

const overlaps = (a: DOMRect, b: DOMRect) => a.width > 0 && a.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const withinBar = (box: DOMRect, bars: DOMRect[]) => bars.some((bar) => box.top >= bar.top - 1 && box.bottom <= bar.bottom + 1 && box.left < bar.right && bar.left < box.right);

function takesMouse(element: HTMLElement, style: CSSStyleDeclaration): boolean {
  if (element.matches(INTERACTIVE)) return true;
  if (!PLAIN_CURSORS.has(style.cursor)) return true;
  return SCROLLING.has(style.overflowY);
}

function barsOf(doc: Document): DOMRect[] {
  const bars: DOMRect[] = [];
  for (const region of doc.querySelectorAll(SYSTEM_REGION)) {
    const box = region.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && box.height <= BAR_HEIGHT) bars.push(box);
  }
  return bars;
}

function coversOf(region: HTMLElement, bars: DOMRect[]): Set<HTMLElement> {
  const covers = new Set<HTMLElement>();
  const view = region.ownerDocument.defaultView;
  const body = region.ownerDocument.body;
  if (!view || !region.isConnected) return covers;
  const area = region.getBoundingClientRect();
  if (!area.width || !area.height) return covers;
  const visit = (node: Element) => {
    if (!isElement(node) || node.dataset[REGION_MARK]) return;
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return;
    const passes = style.pointerEvents === "none";
    const box = node.getBoundingClientRect();
    if (!passes && !overlaps(box, area)) return;
    if (!passes && takesMouse(node, style) && !node.querySelector(SYSTEM_REGION)) {
      covers.add(node);
      return;
    }
    if (passes || withinBar(box, bars) || node.querySelector(SYSTEM_REGION)) {
      for (const child of node.children) visit(child);
      return;
    }
    covers.add(node);
  };
  for (let node: HTMLElement | null = region; node && node !== body; node = node.parentElement) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) visit(next);
  }
  for (const child of region.children) visit(child);
  return covers;
}

function refresh(entry: Tracked, bars: DOMRect[]) {
  const next = coversOf(entry.region, bars);
  for (const element of entry.covers) if (!next.has(element)) release(element);
  for (const element of next) if (!entry.covers.has(element)) claim(element);
  entry.covers = next;
}

function schedule(tracker: DocumentTracker) {
  if (tracker.timer) return;
  tracker.timer = setTimeout(() => {
    tracker.timer = null;
    const first = tracker.regions.values().next().value;
    const bars = first ? barsOf(first.region.ownerDocument) : [];
    for (const entry of tracker.regions) refresh(entry, bars);
    tracker.observer.takeRecords();
  }, PASS_DELAY_MS);
}

function trackerOf(doc: Document): DocumentTracker {
  const existing = trackers.get(doc);
  if (existing) return existing;
  const tracker: DocumentTracker = {
    regions: new Set(),
    timer: null,
    observer: new MutationObserver(() => schedule(tracker)),
    resize: () => schedule(tracker),
  };
  tracker.observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: WATCHED_ATTRIBUTES });
  doc.defaultView?.addEventListener("resize", tracker.resize);
  trackers.set(doc, tracker);
  return tracker;
}

export function markSystemDragRegion(region: HTMLElement): () => void {
  const doc = region.ownerDocument;
  const tracker = trackerOf(doc);
  const entry: Tracked = { region, covers: new Set() };
  region.dataset[REGION_MARK] = "system";
  region.style.setProperty(APP_REGION, "drag");
  tracker.regions.add(entry);
  schedule(tracker);
  return () => {
    tracker.regions.delete(entry);
    for (const element of entry.covers) release(element);
    entry.covers.clear();
    delete region.dataset[REGION_MARK];
    region.style.removeProperty(APP_REGION);
    if (tracker.regions.size) return schedule(tracker);
    tracker.observer.disconnect();
    doc.defaultView?.removeEventListener("resize", tracker.resize);
    if (tracker.timer) clearTimeout(tracker.timer);
    trackers.delete(doc);
  };
}

export function markAppDragRegion(region: HTMLElement): () => void {
  region.dataset[REGION_MARK] = "app";
  region.style.setProperty(APP_REGION, "no-drag");
  return () => {
    delete region.dataset[REGION_MARK];
    region.style.removeProperty(APP_REGION);
  };
}

export function openContextMenuAt(doc: Document, x: number, y: number) {
  const view = doc.defaultView;
  const target = doc.elementFromPoint(x, y);
  if (!view || !target) return;
  target.dispatchEvent(new view.MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, button: 2, buttons: 2, clientX: x, clientY: y, screenX: view.screenX + x, screenY: view.screenY + y, view }));
}
