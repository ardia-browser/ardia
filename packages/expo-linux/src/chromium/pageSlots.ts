import { appDark } from "../appearance";
import { appWindowDocument } from "../windows/appWindows";
import { cutOutKeyframes, cutOutSpread, frostOverPage, holePath, holeRectAt, motionBounds, outermost, pagesToCut, round, type Corners, type Hole, type HoleSamples, type ShownPage } from "./pageSlotRules";

export { frostOverPage, type ShownPage };

type Underlay = { element: HTMLElement; isolates: boolean; solid: boolean; under: Set<string> };
type Members = { underlays: Underlay[]; frosted: HTMLElement[] };
type WindowSlots = { pages: Map<string, ShownPage>; underlays: Underlay[]; frosted: HTMLElement[]; membersAt: number; observer: MutationObserver | null; queued: boolean; settling: ReturnType<typeof setTimeout> | null };

export const SLOT_MARKER = "ardiaPageSlot";
const SLOT_SELECTOR = "[data-ardia-page-slot]";
const UNDERLAY = "ardiaUnderlay";
const OVER_PAGE = "ardiaOverPage";
const CUT_OUT = "ardiaCutOut";
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
[data-ardia-over-page] { background-color: var(--ardia-over-page-color) !important; }
[data-ardia-cut-out] { isolation: isolate; }
[data-ardia-underlay][data-ardia-cut-out]::before { display: none; }`;

const windows = new Map<string, WindowSlots>();
const painted = new Set<string>();
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

const solidFill = (style: CSSStyleDeclaration) => style.backgroundImage === "none" && (style.backdropFilter === "none" || style.backdropFilter === "") && style.position !== "static";

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
      element.style.setProperty("--ardia-over-page-color", frostOverPage(style.backgroundColor, appDark()));
      found.frosted.push(element);
      continue;
    }
    if (!under.size) continue;
    remember(element, style);
    found.underlays.push({ element, isolates: style.zIndex === "auto" && element.childElementCount > 0, solid: solidFill(style), under });
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

function clipFor(element: HTMLElement, under: Set<string>, holes: Map<string, Hole>): string {
  const box = element.getBoundingClientRect();
  const width = element.offsetWidth || box.width;
  const height = element.offsetHeight || box.height;
  const sx = width > 0 ? box.width / width : 1;
  const sy = height > 0 ? box.height / height : 1;
  const local = (hole: Hole): Hole => ({
    x: (hole.x - box.x) / sx - element.clientLeft,
    y: (hole.y - box.y) / sy - element.clientTop,
    width: hole.width / sx,
    height: hole.height / sy,
    radius: hole.radius,
    corners: hole.corners.map((corner) => corner / Math.min(sx, sy)) as Corners,
  });
  const outer = `M-1,-1 H${round(width + 2)} V${round(height + 2)} H-1 Z`;
  const meeting = [...under].flatMap((key) => {
    const hole = holes.get(key);
    return hole && intersects(box, hole) ? [hole] : [];
  });
  const inside = outermost(meeting).map((hole) => holePath(local(hole), 0, 0));
  return inside.length ? `path(evenodd, "${outer} ${inside.join(" ")}")` : "none";
}

type CutOut = { wrapper: HTMLElement; animation: Animation };
type HoleMotion = HoleSamples & { page: Element; moving: Element; played: Animation; endsAt: number; cutOuts: Map<HTMLElement, CutOut> };

const holeMotions = new Map<string, HoleMotion>();
let holeFrames = 0;
let holeLoop = false;
let cutOutsMade = 0;

const elapsedOf = (motion: HoleMotion) => Number(motion.played.currentTime ?? 0);

function movingHoles(holes: Map<string, Hole>, element: Element): Map<string, Hole> {
  if (!holeMotions.size) return holes;
  const moved = new Map(holes);
  for (const [key, motion] of holeMotions) {
    const resting = holes.get(key);
    if (!resting || !motion.page.isConnected) continue;
    if (motion.moving.contains(element)) {
      const box = motion.page.getBoundingClientRect();
      moved.set(key, { ...resting, x: box.x, y: box.y, width: box.width, height: box.height });
      continue;
    }
    const [x = 0, y = 0, width = 0, height = 0] = holeRectAt(motion, elapsedOf(motion)) ?? [];
    moved.set(key, { ...resting, x, y, width, height });
  }
  return moved;
}

function makeCutOut(element: HTMLElement, motion: HoleMotion, resting: Hole): CutOut | null {
  const doc = element.ownerDocument;
  const box = element.getBoundingClientRect();
  const width = element.offsetWidth || box.width;
  const height = element.offsetHeight || box.height;
  if (!width || !height) return null;
  const sx = box.width / width || 1;
  const sy = box.height / height || 1;
  const local = motion.rects.map(([x = 0, y = 0, w = 0, h = 0]) => ({ x: (x - box.x) / sx - element.clientLeft, y: (y - box.y) / sy - element.clientTop, width: w / sx, height: h / sy }));
  const keyframes = cutOutKeyframes(local, motion.offsets);
  const base = local[local.length - 1];
  if (!keyframes.length || !base) return null;
  const wrapper = doc.createElement("div");
  wrapper.dataset.ardiaCutOutLayer = "";
  Object.assign(wrapper.style, { position: "absolute", inset: "0", zIndex: "-1", overflow: "hidden", pointerEvents: "none", borderRadius: "inherit" });
  const hole = doc.createElement("div");
  const corners = resting.corners.map((corner) => `${round(corner / Math.min(sx, sy))}px`).join(" ");
  Object.assign(hole.style, {
    position: "absolute",
    left: `${round(base.x)}px`,
    top: `${round(base.y)}px`,
    width: `${round(base.width)}px`,
    height: `${round(base.height)}px`,
    borderRadius: corners,
    transformOrigin: "0 0",
    boxShadow: `0 0 0 ${cutOutSpread(local, width, height)}px var(--ardia-underlay-color)`,
  });
  wrapper.appendChild(hole);
  element.appendChild(wrapper);
  const animation = hole.animate(keyframes, { duration: motion.durationMs, easing: "linear", fill: "forwards" });
  const follow = () => {
    if (motion.played.startTime !== null) animation.startTime = motion.played.startTime;
  };
  follow();
  void motion.played.ready.then(follow, () => {});
  element.dataset[CUT_OUT] = "";
  cutOutsMade += 1;
  return { wrapper, animation };
}

function dropCutOuts(motion: HoleMotion) {
  for (const [element, cutOut] of motion.cutOuts) {
    cutOut.animation.cancel();
    cutOut.wrapper.remove();
    delete element.dataset[CUT_OUT];
  }
  motion.cutOuts.clear();
}

function cutOutFor(underlay: Underlay, holes: Map<string, Hole>): boolean {
  const { element, under, solid } = underlay;
  const box = element.getBoundingClientRect();
  const meeting = [...under].filter((key) => {
    const hole = holes.get(key);
    const moving = holeMotions.get(key);
    return (hole && intersects(box, hole)) || (moving && intersects(box, motionBounds(moving)));
  });
  const [key] = meeting;
  const motion = key === undefined ? undefined : holeMotions.get(key);
  if (!motion || meeting.length !== 1 || motion.moving.contains(element)) return false;
  if (motion.cutOuts.has(element)) return true;
  const resting = key === undefined ? undefined : holes.get(key);
  if (!solid || !resting) return false;
  const made = makeCutOut(element, motion, resting);
  if (!made) return false;
  motion.cutOuts.set(element, made);
  return true;
}

const heldClips = new WeakMap<HTMLElement, string>();

const ridesMotion = (element: HTMLElement) => [...holeMotions.values()].some((motion) => motion.moving.contains(element));

function followHoles() {
  for (const [key, motion] of holeMotions) if (performance.now() >= motion.endsAt || !motion.page.isConnected) endHoleMotion(key);
  for (const [windowId, slots] of windows) if ([...holeMotions.keys()].some((key) => slots.pages.has(key))) update(windowId);
  holeFrames += 1;
  if (holeMotions.size) requestAnimationFrame(followHoles);
  else holeLoop = false;
}

function endHoleMotion(key: string): boolean {
  const motion = holeMotions.get(key);
  if (!motion) return false;
  holeMotions.delete(key);
  dropCutOuts(motion);
  return true;
}

export type { HoleSamples };

export function animatePageHoles(key: string, page: Element, moving: Element, played: Animation, samples: HoleSamples) {
  endHoleMotion(key);
  holeMotions.set(key, { ...samples, page, moving, played, endsAt: performance.now() + samples.durationMs + 50, cutOuts: new Map() });
  for (const [windowId, slots] of windows) if (slots.pages.has(key)) update(windowId);
  if (holeLoop) return;
  holeLoop = true;
  requestAnimationFrame(followHoles);
}

export function stopPageHoles(key: string) {
  if (!endHoleMotion(key)) return;
  for (const [windowId, slots] of windows) if (slots.pages.has(key)) update(windowId);
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
  const pages = pagesToCut(slots.pages, painted);
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
  const holes = holesFor(pages, slots.underlays, view);
  for (const underlay of slots.underlays) {
    if (cutOutFor(underlay, holes)) continue;
    const riding = ridesMotion(underlay.element);
    const painted = [...underlay.under].filter((key) => pages.has(key)).join(" ");
    if (riding && heldClips.get(underlay.element) === painted) continue;
    underlay.element.style.setProperty("--ardia-underlay-clip", clipFor(underlay.element, underlay.under, movingHoles(holes, underlay.element)));
    if (riding) heldClips.set(underlay.element, painted);
    else heldClips.delete(underlay.element);
  }
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
  holeFrames,
  cutOuts: cutOutsMade,
  windows: Object.fromEntries([...windows].map(([id, slots]) => [id, { pages: slots.pages.size, underlays: slots.underlays.length, frosted: slots.frosted.length }])),
});

export function notePagePainted(key: string) {
  if (painted.has(key)) return;
  painted.add(key);
  for (const [windowId, slots] of windows) {
    if (!slots.pages.has(key)) continue;
    slots.membersAt = 0;
    update(windowId);
  }
}
