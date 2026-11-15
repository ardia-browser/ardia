import { appWindowDocument } from "../windows/appWindows";

export type ShownPage = { x: number; y: number; width: number; height: number; radius: number };

type Corners = [number, number, number, number];
type Hole = ShownPage & { corners: Corners };
type Underlay = { element: HTMLElement; isolates: boolean; under: Set<string> };
type Members = { underlays: Underlay[]; frosted: HTMLElement[] };
type WindowSlots = { pages: Map<string, ShownPage>; underlays: Underlay[]; frosted: HTMLElement[]; membersAt: number; observer: MutationObserver | null; queued: boolean; settling: ReturnType<typeof setTimeout> | null };

export const SLOT_MARKER = "ardiaPageSlot";
const SLOT_SELECTOR = "[data-ardia-page-slot]";
const UNDERLAY = "ardiaUnderlay";
const OVER_PAGE = "ardiaOverPage";
const DENSEST_FROST = 0.94;
const STYLE_ID = "ardia-page-slots";
const MEMBERS_REFRESH_MS = 120;
const SETTLE_AFTER_CHANGES_MS = 60;
const CORNER_SLOP = 1.5;
const TRANSPARENT = new Set(["rgba(0, 0, 0, 0)", "transparent"]);

const STYLES = `
[data-ardia-underlay] { background-color: transparent !important; background-image: none !important; backdrop-filter: none !important; }
[data-ardia-underlay="isolate"] { isolation: isolate; }
[data-ardia-underlay]::before {
  content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; border-radius: inherit;
  background-color: var(--ardia-underlay-color); background-image: var(--ardia-underlay-image);
  background-size: var(--ardia-underlay-size); background-position: var(--ardia-underlay-position); background-repeat: var(--ardia-underlay-repeat);
  backdrop-filter: var(--ardia-underlay-backdrop); clip-path: var(--ardia-underlay-clip);
}
[data-ardia-over-page] { background-color: color(from var(--ardia-over-page-color) srgb r g b / max(alpha, ${DENSEST_FROST})) !important; }`;

const windows = new Map<string, WindowSlots>();
let underlaysMarked = 0;
let frostedMarked = 0;

const slotsOf = (windowId: string): WindowSlots => {
  let slots = windows.get(windowId);
  if (!slots) windows.set(windowId, (slots = { pages: new Map(), underlays: [], frosted: [], membersAt: 0, observer: null, queued: false, settling: null }));
  return slots;
};

function ensureStyles(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

function paints(style: CSSStyleDeclaration) {
  return !TRANSPARENT.has(style.backgroundColor) || style.backgroundImage !== "none" || (style.backdropFilter !== "none" && style.backdropFilter !== "");
}

const intersects = (box: DOMRect, page: ShownPage) => box.left < page.x + page.width && box.right > page.x && box.top < page.y + page.height && box.bottom > page.y;

function precedes(element: Element, marker: Element) {
  const position = element.compareDocumentPosition(marker);
  return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 || (position & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0;
}

function unmark(element: HTMLElement) {
  delete element.dataset[UNDERLAY];
  for (const name of ["color", "image", "size", "position", "repeat", "backdrop", "clip"]) element.style.removeProperty(`--ardia-underlay-${name}`);
}

function remember(element: HTMLElement, style: CSSStyleDeclaration) {
  element.style.setProperty("--ardia-underlay-color", style.backgroundColor);
  element.style.setProperty("--ardia-underlay-image", style.backgroundImage);
  element.style.setProperty("--ardia-underlay-size", style.backgroundSize);
  element.style.setProperty("--ardia-underlay-position", style.backgroundPosition);
  element.style.setProperty("--ardia-underlay-repeat", style.backgroundRepeat);
  element.style.setProperty("--ardia-underlay-backdrop", style.backdropFilter || "none");
}

function unfrost(element: HTMLElement) {
  delete element.dataset[OVER_PAGE];
  element.style.removeProperty("--ardia-over-page-color");
}

const frostedOverPages = (style: CSSStyleDeclaration) => style.backdropFilter !== "none" && style.backdropFilter !== "" && !TRANSPARENT.has(style.backgroundColor);

function findMembers(doc: Document, pages: Map<string, ShownPage>, previous: Members): Members {
  for (const { element } of previous.underlays) delete element.dataset[UNDERLAY];
  for (const element of previous.frosted) delete element.dataset[OVER_PAGE];
  const markers = new Map<string, HTMLElement>();
  for (const marker of doc.querySelectorAll<HTMLElement>(SLOT_SELECTOR)) markers.set(marker.dataset[SLOT_MARKER] ?? "", marker);
  const slots = [...pages].flatMap(([key, page]) => {
    const marker = markers.get(key);
    return marker ? [{ key, page, marker }] : [];
  });
  const view = doc.defaultView;
  const found: Members = { underlays: [], frosted: [] };
  if (!slots.length || !view) {
    for (const { element } of previous.underlays) unmark(element);
    for (const element of previous.frosted) unfrost(element);
    return found;
  }
  for (const element of doc.body.querySelectorAll<HTMLElement>("*")) {
    if (element.matches(SLOT_SELECTOR)) continue;
    const box = element.getBoundingClientRect();
    const meeting = slots.filter((slot) => intersects(box, slot.page));
    if (!meeting.length) continue;
    const style = view.getComputedStyle(element);
    if (!paints(style)) continue;
    const under = new Set(meeting.filter((slot) => precedes(element, slot.marker)).map((slot) => slot.key));
    if (under.size < meeting.length && frostedOverPages(style)) {
      element.style.setProperty("--ardia-over-page-color", style.backgroundColor);
      found.frosted.push(element);
      continue;
    }
    if (!under.size) continue;
    remember(element, style);
    found.underlays.push({ element, isolates: style.zIndex === "auto" && element.childElementCount > 0, under });
  }
  const keptUnderlays = new Set(found.underlays.map((underlay) => underlay.element));
  for (const { element } of previous.underlays) if (!keptUnderlays.has(element)) unmark(element);
  const keptFrosted = new Set(found.frosted);
  for (const element of previous.frosted) if (!keptFrosted.has(element)) unfrost(element);
  for (const { element, isolates } of found.underlays) element.dataset[UNDERLAY] = isolates ? "isolate" : "";
  for (const element of found.frosted) element.dataset[OVER_PAGE] = "";
  underlaysMarked = found.underlays.length;
  frostedMarked = found.frosted.length;
  return found;
}

function cornerRadii(box: DOMRect, style: CSSStyleDeclaration): Corners {
  const radius = (value: string) => Math.min(parseFloat(value) || 0, box.width / 2, box.height / 2);
  return [radius(style.borderTopLeftRadius), radius(style.borderTopRightRadius), radius(style.borderBottomRightRadius), radius(style.borderBottomLeftRadius)];
}

function holesFor(pages: Map<string, ShownPage>, underlays: Underlay[], view: Window): Map<string, Hole> {
  const holes = new Map<string, Hole>();
  for (const [key, page] of pages) {
    const corners: Corners = [page.radius, page.radius, page.radius, page.radius];
    const right = page.x + page.width;
    const bottom = page.y + page.height;
    for (const { element, under } of underlays) {
      if (!under.has(key)) continue;
      const box = element.getBoundingClientRect();
      const radii = cornerRadii(box, view.getComputedStyle(element));
      const near = (a: number, b: number) => Math.abs(a - b) <= CORNER_SLOP;
      if (near(box.left, page.x) && near(box.top, page.y)) corners[0] = Math.max(corners[0], radii[0]);
      if (near(box.right, right) && near(box.top, page.y)) corners[1] = Math.max(corners[1], radii[1]);
      if (near(box.right, right) && near(box.bottom, bottom)) corners[2] = Math.max(corners[2], radii[2]);
      if (near(box.left, page.x) && near(box.bottom, bottom)) corners[3] = Math.max(corners[3], radii[3]);
    }
    holes.set(key, { ...page, corners });
  }
  return holes;
}

const round = (value: number) => Math.round(value * 100) / 100;

function holePath(hole: Hole, left: number, top: number): string {
  const x = round(hole.x - left);
  const y = round(hole.y - top);
  const w = round(hole.width);
  const h = round(hole.height);
  const [tl, tr, br, bl] = hole.corners.map((corner) => round(Math.min(corner, w / 2, h / 2))) as Corners;
  return `M${x + tl},${y} H${x + w - tr} A${tr},${tr} 0 0 1 ${x + w},${y + tr} V${y + h - br} A${br},${br} 0 0 1 ${x + w - br},${y + h} H${x + bl} A${bl},${bl} 0 0 1 ${x},${y + h - bl} V${y + tl} A${tl},${tl} 0 0 1 ${x + tl},${y} Z`;
}

const contains = (outer: ShownPage, inner: ShownPage) =>
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;

function outermost(holes: Hole[]): Hole[] {
  return holes.filter((hole, index) => !holes.some((other, at) => at !== index && contains(other, hole) && (!contains(hole, other) || at < index)));
}

function cut(underlays: Underlay[], holes: Map<string, Hole>) {
  for (const { element, under } of underlays) {
    const box = element.getBoundingClientRect();
    const left = box.left + element.clientLeft;
    const top = box.top + element.clientTop;
    const outer = `M-1,-1 H${round(box.width + 2)} V${round(box.height + 2)} H-1 Z`;
    const meeting = [...under].flatMap((key) => {
      const hole = holes.get(key);
      return hole && intersects(box, hole) ? [hole] : [];
    });
    const inside = outermost(meeting).map((hole) => holePath(hole, left, top));
    element.style.setProperty("--ardia-underlay-clip", inside.length ? `path(evenodd, "${outer} ${inside.join(" ")}")` : "none");
  }
}

function watchMembers(doc: Document, slots: WindowSlots, windowId: string) {
  if (slots.observer) return;
  const view = doc.defaultView;
  if (!view) return;
  slots.observer = new view.MutationObserver(() => {
    slots.membersAt = 0;
    if (slots.settling !== null) return;
    slots.settling = setTimeout(() => {
      slots.settling = null;
      update(windowId);
    }, SETTLE_AFTER_CHANGES_MS);
  });
  slots.observer.observe(doc.body, { childList: true, subtree: true });
}

function update(windowId: string) {
  const slots = windows.get(windowId);
  if (!slots) return;
  slots.queued = false;
  const doc = appWindowDocument(windowId);
  const view = doc?.defaultView;
  if (!doc || !view) return;
  const pages = slots.pages;
  if (!pages.size) {
    for (const { element } of slots.underlays) unmark(element);
    for (const element of slots.frosted) unfrost(element);
    slots.underlays = [];
    slots.frosted = [];
    return;
  }
  ensureStyles(doc);
  watchMembers(doc, slots, windowId);
  const now = performance.now();
  if (!slots.membersAt || now - slots.membersAt > MEMBERS_REFRESH_MS) {
    const members = findMembers(doc, pages, slots);
    slots.underlays = members.underlays;
    slots.frosted = members.frosted;
    slots.membersAt = now;
  }
  cut(slots.underlays, holesFor(pages, slots.underlays, view));
}

export function noteShownPage(windowId: string, key: string, page: ShownPage | null) {
  if (!windowId) return;
  const slots = slotsOf(windowId);
  const before = slots.pages.size;
  if (page) slots.pages.set(key, page);
  else slots.pages.delete(key);
  if (slots.pages.size !== before) slots.membersAt = 0;
  if (slots.queued) return;
  slots.queued = true;
  queueMicrotask(() => update(windowId));
}

export function refreshPageSlots() {
  for (const [windowId, slots] of windows) {
    slots.membersAt = 0;
    update(windowId);
  }
}

export const pageSlotsState = () => ({
  underlays: underlaysMarked,
  frosted: frostedMarked,
  windows: Object.fromEntries([...windows].map(([id, slots]) => [id, { pages: slots.pages.size, underlays: slots.underlays.length, frosted: slots.frosted.length }])),
});
