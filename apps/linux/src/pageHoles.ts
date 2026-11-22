import { intersection, subtract, type PageArea, type Rect } from "./inputRegions.ts";
import type { CornerRadii } from "./hostExtensionView.ts";

export const PAGE_CORNER_RADIUS = 12;
export const HOLE_HOST_CLASS = "ardia-hole-host";
export const PAGE_STACK_ATTRIBUTE = "data-ardia-page-stack";
const FILL_VAR = "--ardia-hole-fill";
const CLIP_VAR = "--ardia-hole-clip";

const n = (value: number) => +value.toFixed(2);

export type Radii = readonly [topLeft: number, topRight: number, bottomRight: number, bottomLeft: number];
export type HolePiece = { rect: Rect; radii: Radii };
export type FloatingHole = { rect: Rect; radius: number };
export type Hole = Rect & { radii?: CornerRadii };

const tupleOf = (radii: CornerRadii): Radii => [radii.upperLeft, radii.upperRight, radii.lowerRight, radii.lowerLeft];

export function roundedRect({ x, y, width, height }: Rect, radius: number | Radii) {
  const fit = (r: number) => Math.max(0, Math.min(r, width / 2, height / 2));
  const corners: Radii = typeof radius === "number" ? [radius, radius, radius, radius] : radius;
  const tl = fit(corners[0]);
  const tr = fit(corners[1]);
  const br = fit(corners[2]);
  const bl = fit(corners[3]);
  const right = x + width;
  const bottom = y + height;
  const arc = (r: number, toX: number, toY: number) => (r ? `A${n(r)} ${n(r)} 0 0 1 ${n(toX)} ${n(toY)}` : "");
  return `M${n(x + tl)} ${n(y)}H${n(right - tr)}${arc(tr, right, y + tr)}V${n(bottom - br)}${arc(br, right - br, bottom)}H${n(x + bl)}${arc(bl, x, bottom - bl)}V${n(y + tl)}${arc(tl, x + tl, y)}Z`;
}

export type WindowSize = { width: number; height: number };

export function windowCornerRadii(rect: Rect, window: WindowSize, radius = PAGE_CORNER_RADIUS, zoom = 1): CornerRadii {
  const left = rect.x * zoom < 1;
  const top = rect.y * zoom < 1;
  const right = (rect.x + rect.width) * zoom > window.width * zoom - 1;
  const bottom = (rect.y + rect.height) * zoom > window.height * zoom - 1;
  return {
    upperLeft: top && left ? 0 : radius,
    upperRight: top && right ? 0 : radius,
    lowerRight: bottom && right ? 0 : radius,
    lowerLeft: bottom && left ? 0 : radius,
  };
}

export function holeClipPath(box: { width: number; height: number }, holes: readonly Hole[], radius = PAGE_CORNER_RADIUS, pieces: readonly HolePiece[] = []) {
  if (!holes.length && !pieces.length) return "";
  const outer = `M0 0H${n(box.width)}V${n(box.height)}H0Z`;
  return `path(evenodd, "${[outer, ...holes.map((hole) => roundedRect(hole, hole.radii ? tupleOf(hole.radii) : radius)), ...pieces.map((piece) => roundedRect(piece.rect, piece.radii))].join(" ")}")`;
}

export function floatingPieces(hole: FloatingHole, pages: readonly Rect[]): HolePiece[] {
  const { rect, radius } = hole;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  let pieces: Rect[] = [rect];
  for (const page of pages) pieces = pieces.flatMap((piece) => subtract(piece, page));
  return pieces.map((piece) => {
    const pieceRight = piece.x + piece.width;
    const pieceBottom = piece.y + piece.height;
    const corner = (x: number, y: number, cornerX: number, cornerY: number) => (near(x, cornerX) && near(y, cornerY) ? radius : 0);
    return {
      rect: piece,
      radii: [corner(piece.x, piece.y, rect.x, rect.y), corner(pieceRight, piece.y, right, rect.y), corner(pieceRight, pieceBottom, right, bottom), corner(piece.x, pieceBottom, rect.x, bottom)] as const,
    };
  });
}

export function separateHoles(holes: readonly Hole[], radius = PAGE_CORNER_RADIUS): { holes: Hole[]; pieces: HolePiece[] } {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const whole: Hole[] = [];
  const pieces: HolePiece[] = [];
  holes.forEach((hole, index) => {
    const earlier = holes.slice(0, index).filter((other) => intersection(hole, other));
    if (!earlier.length) return void whole.push(hole);
    const corners: Radii = hole.radii ? tupleOf(hole.radii) : [radius, radius, radius, radius];
    const right = hole.x + hole.width;
    const bottom = hole.y + hole.height;
    let rest: Rect[] = [{ x: hole.x, y: hole.y, width: hole.width, height: hole.height }];
    for (const other of earlier) rest = rest.flatMap((piece) => subtract(piece, other));
    for (const piece of rest) {
      const pieceRight = piece.x + piece.width;
      const pieceBottom = piece.y + piece.height;
      const corner = (x: number, y: number, cornerX: number, cornerY: number, r: number) => (near(x, cornerX) && near(y, cornerY) ? r : 0);
      pieces.push({
        rect: piece,
        radii: [corner(piece.x, piece.y, hole.x, hole.y, corners[0]), corner(pieceRight, piece.y, right, hole.y, corners[1]), corner(pieceRight, pieceBottom, right, bottom, corners[2]), corner(piece.x, pieceBottom, hole.x, bottom, corners[3])],
      });
    }
  });
  return { holes: whole, pieces };
}

export function localPieces(layer: Rect, scale: { x: number; y: number }, pieces: readonly HolePiece[]) {
  return pieces.filter((piece) => intersection(piece.rect, layer)).map((piece) => ({
    rect: { x: (piece.rect.x - layer.x) / scale.x, y: (piece.rect.y - layer.y) / scale.y, width: piece.rect.width / scale.x, height: piece.rect.height / scale.y },
    radii: piece.radii.map((radius) => radius / Math.min(scale.x, scale.y)) as unknown as Radii,
  }));
}

export function localHoles(layer: Rect, scale: { x: number; y: number }, pages: readonly Hole[]) {
  const holes: Hole[] = [];
  const shrink = Math.max(scale.x, scale.y) || 1;
  for (const page of pages) {
    if (!intersection(page, layer)) continue;
    const hole: Hole = { x: (page.x - layer.x) / scale.x, y: (page.y - layer.y) / scale.y, width: page.width / scale.x, height: page.height / scale.y };
    if (page.radii) hole.radii = { upperLeft: page.radii.upperLeft / shrink, upperRight: page.radii.upperRight / shrink, lowerRight: page.radii.lowerRight / shrink, lowerLeft: page.radii.lowerLeft / shrink };
    holes.push(hole);
  }
  return holes;
}

export type StackDom<E> = { stackOf: (element: E) => E | null; contains: (outer: E, inner: E) => boolean };

export function pagesAbove<E, P extends { slot: E }>(element: E, pages: readonly P[], dom: StackDom<E>): readonly P[] {
  const stack = dom.stackOf(element);
  return stack ? pages.filter((page) => dom.contains(stack, page.slot)) : pages;
}

export type PainterDom<E> = {
  contains: (outer: E, inner: E) => boolean;
  precedes: (element: E, slot: E) => boolean;
  overlaps: (element: E, slot: E) => boolean;
  paints: (element: E) => boolean;
};

export function paintersBeneath<E>(slot: E, candidates: Iterable<E>, dom: PainterDom<E>): E[] {
  const found: E[] = [];
  for (const element of candidates) {
    if (element === slot || dom.contains(element, slot) || dom.contains(slot, element)) continue;
    if (dom.precedes(element, slot) && dom.overlaps(element, slot) && dom.paints(element)) found.push(element);
  }
  return found;
}

const transparent = (color: string) => !color || color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color);

const box = (element: HTMLElement): Rect => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};

const clipFor = (element: HTMLElement, pages: readonly Hole[], pieces: readonly HolePiece[] = []) => {
  const rect = box(element);
  const scale = { x: element.offsetWidth ? rect.width / element.offsetWidth : 1, y: element.offsetHeight ? rect.height / element.offsetHeight : 1 };
  const separate = separateHoles(pages);
  return holeClipPath({ width: element.offsetWidth, height: element.offsetHeight }, localHoles(rect, scale, separate.holes), PAGE_CORNER_RADIUS, localPieces(rect, scale, [...separate.pieces, ...pieces]));
};

export const holesOf = (pages: readonly PageArea[], window: WindowSize, zoom = 1): Hole[] =>
  pages.map(({ rect, radii }) => ({ ...rect, radii: radii ?? windowCornerRadii(rect, window, PAGE_CORNER_RADIUS, zoom) }));

const shellViewport = (root: HTMLElement): WindowSize => ({
  width: root.ownerDocument.documentElement.clientWidth,
  height: root.ownerDocument.documentElement.clientHeight,
});

const stackDom: StackDom<Element> = {
  stackOf: (element) => element.closest(`[${PAGE_STACK_ATTRIBUTE}]`),
  contains: (outer, inner) => outer.contains(inner),
};

const overlapping = (a: Element, b: Element) => {
  const one = a.getBoundingClientRect();
  const two = b.getBoundingClientRect();
  return !!intersection({ x: one.x, y: one.y, width: one.width, height: one.height }, { x: two.x, y: two.y, width: two.width, height: two.height });
};

export function createPageHoles(root: HTMLElement, zoom: () => number = () => 1) {
  const layers = new Set<HTMLElement>();
  const hosts = new Map<HTMLElement, string>();
  let pages: readonly PageArea[] = [];
  let floating: FloatingHole | null = null;
  let floatingHosts: readonly HTMLElement[] = [];
  let queued = false;
  const pieces = () => (floating ? floatingPieces(floating, pages.map((page) => page.rect)) : []);

  const setStyle = (element: HTMLElement, name: string, value: string) => {
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
  };

  const holesUnder = (element: HTMLElement) => holesOf(pagesAbove(element, pages, stackDom), shellViewport(root), zoom());

  const paintLayer = (layer: HTMLElement) => {
    const clip = clipFor(layer, holesUnder(layer), pieces());
    if (layer.style.clipPath !== clip) layer.style.clipPath = clip;
  };

  const ancestorsOf = (slot: Element) => {
    const chain: HTMLElement[] = [];
    for (let node = slot.parentElement; node && node !== root; node = node.parentElement) chain.push(node);
    return chain;
  };

  const syncHosts = () => {
    const floatingRects = pieces();
    const painting = new Set<HTMLElement>();
    const paints = (node: HTMLElement) => hosts.has(node) || !transparent(node.style.backgroundColor) || !transparent(getComputedStyle(node).backgroundColor);
    const painterDom: PainterDom<HTMLElement> = {
      contains: (outer, inner) => outer.contains(inner),
      precedes: (element, slot) => !!(element.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING),
      overlaps: overlapping,
      paints,
    };
    for (const { slot } of pages) {
      for (const node of ancestorsOf(slot)) {
        if (paints(node)) painting.add(node);
      }
      const stack = slot.parentElement?.closest<HTMLElement>(`[${PAGE_STACK_ATTRIBUTE}]`);
      if (stack) for (const node of paintersBeneath(slot as HTMLElement, stack.querySelectorAll<HTMLElement>("*"), painterDom)) painting.add(node);
    }
    if (floating) for (const node of floatingHosts) if (node.isConnected && paints(node)) painting.add(node);
    for (const host of hosts.keys()) {
      if (painting.has(host)) continue;
      host.classList.remove(HOLE_HOST_CLASS);
      host.style.removeProperty(FILL_VAR);
      host.style.removeProperty(CLIP_VAR);
      hosts.delete(host);
    }
    for (const host of painting) {
      if (!hosts.has(host)) {
        hosts.set(host, host.style.backgroundColor ? "" : getComputedStyle(host).backgroundColor);
        host.classList.add(HOLE_HOST_CLASS);
      }
      setStyle(host, FILL_VAR, host.style.backgroundColor || hosts.get(host)!);
      setStyle(host, CLIP_VAR, clipFor(host, holesUnder(host), floatingRects) || "none");
    }
    watched.disconnect();
    for (const { slot } of pages) for (const node of ancestorsOf(slot)) watched.observe(node, { attributes: true, attributeFilter: ["style"] });
  };

  const watched = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      syncHosts();
    });
  });

  const resized = new ResizeObserver((entries) => {
    for (const entry of entries) if (layers.has(entry.target as HTMLElement)) paintLayer(entry.target as HTMLElement);
  });

  return {
    pagesChanged(next: readonly PageArea[]) {
      pages = next;
      for (const layer of layers) paintLayer(layer);
      syncHosts();
    },
    setFloating(hole: FloatingHole | null, nextHosts: readonly HTMLElement[] = []) {
      floating = hole;
      floatingHosts = hole ? nextHosts : [];
      for (const layer of layers) paintLayer(layer);
      syncHosts();
    },
    isLayer: (element: Element) => layers.has(element as HTMLElement),
    isHost: (element: Element) => hosts.has(element as HTMLElement),
    addLayer(layer: HTMLElement) {
      layers.add(layer);
      resized.observe(layer);
      paintLayer(layer);
      return () => {
        layers.delete(layer);
        resized.unobserve(layer);
        layer.style.clipPath = "";
      };
    },
  };
}

export type PageHoles = ReturnType<typeof createPageHoles>;
