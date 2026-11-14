import { callMain, callMainSync } from "../bridge";
import { mirrorStylesInto } from "../host/documentStyles";

type Rect4 = [number, number, number, number];
type Shape = "hidden" | "pill" | "card";
type Realm = Window & typeof globalThis;
type Drag = { source: string; chip: Rect4; grab: [number, number]; picture: string | null; aspect: number; title: string; favicon: string | null; shape: Shape };
type Bounds = { x: number; y: number; width: number; height: number };
type Target = { bounds: Bounds; shown: boolean; found: boolean };
type WindowSnapshot = { url: string; width: number; height: number };

const NAME = "ardia-drag-preview";
const MODULE = "ArdiaAppWindows";
const CARD_WIDTH = 300;
const CARD_GRAB: [number, number] = [36, 22];
const MARGIN = 18;
const GROW_MS = 200;
const FADE_MS = 100;
const SETTLED_RADIUS = 12;
const FIND_FRAMES = 20;
const REVEAL_WAIT_MS = 1500;
const FRAME_MS = 16;

let realm: Realm | null = null;
let drag: Drag | null = null;
let windowPicture: { image: HTMLImageElement; width: number; height: number } | null = null;
let pagePicture: { image: HTMLImageElement; frame: Rect4 } | null = null;
let generation = 0;

const css = `
html, body { margin: 0; background: transparent; overflow: hidden; font: 13px system-ui, sans-serif; user-select: none; }
#preview { position: absolute; inset: ${MARGIN}px; display: flex; overflow: hidden; }
#preview.pill { align-items: center; gap: 8px; padding: 0 10px; border-radius: 9px; background: rgba(255,255,255,0.96); color: #1d1d1f; box-shadow: 0 6px 18px rgba(0,0,0,0.22), 0 0 0 0.5px rgba(0,0,0,0.18); }
#preview.card { border-radius: 10px; background: #fff; box-shadow: 0 10px 28px rgba(0,0,0,0.3), 0 0 0 0.5px rgba(0,0,0,0.2); }
#preview.card img.picture { width: 100%; height: 100%; object-fit: cover; }
#preview.card .placeholder { margin: auto; display: flex; align-items: center; gap: 8px; color: #555; padding: 0 16px; }
#preview img.icon { width: 16px; height: 16px; flex: none; }
#preview .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#preview.settle { inset: 0; border-radius: ${SETTLED_RADIUS}px; background: transparent; box-shadow: 0 10px 28px rgba(0,0,0,0.3); }
#preview.settle img.picture { width: 100%; height: 100%; object-fit: fill; }
`;

function previewWindow(): Realm | null {
  if (realm && !realm.closed) return realm;
  callMainSync(MODULE, "shapeDragPreview");
  realm = window.open("about:blank", NAME) as Realm | null;
  if (!realm) return null;
  const doc = realm.document;
  mirrorStylesInto(doc);
  const style = doc.createElement("style");
  style.textContent = css;
  doc.head.appendChild(style);
  const box = doc.createElement("div");
  box.id = "preview";
  doc.body.appendChild(box);
  return realm;
}

function labelled(doc: Document, title: string, favicon: string | null) {
  const nodes: Node[] = [];
  if (favicon) {
    const icon = doc.createElement("img");
    icon.className = "icon";
    icon.src = favicon;
    nodes.push(icon);
  }
  const text = doc.createElement("span");
  text.className = "title";
  text.textContent = title;
  nodes.push(text);
  return nodes;
}

function render(point: [number, number]) {
  if (!drag) return;
  if (drag.shape === "hidden") return void callMainSync(MODULE, "hideDragPreview");
  const doc = previewWindow()?.document;
  const box = doc?.getElementById("preview");
  if (!doc || !box) return;
  box.className = drag.shape;
  if (drag.shape === "pill") {
    box.replaceChildren(...labelled(doc, drag.title, drag.favicon));
    const [, , width, height] = drag.chip;
    const left = point[0] - drag.grab[0] - MARGIN;
    const top = point[1] - drag.grab[1] - MARGIN;
    return void callMainSync(MODULE, "moveDragPreview", drag.source, left, top, width + 2 * MARGIN, height + 2 * MARGIN);
  }
  if (drag.picture) {
    const picture = doc.createElement("img");
    picture.className = "picture";
    picture.src = drag.picture;
    box.replaceChildren(picture);
  } else {
    const placeholder = doc.createElement("div");
    placeholder.className = "placeholder";
    placeholder.append(...labelled(doc, drag.title, drag.favicon));
    box.replaceChildren(placeholder);
  }
  const height = Math.round(CARD_WIDTH / drag.aspect);
  callMainSync(MODULE, "moveDragPreview", drag.source, point[0] - CARD_GRAB[0] - MARGIN, point[1] - CARD_GRAB[1] - MARGIN, CARD_WIDTH + 2 * MARGIN, height + 2 * MARGIN);
}

function hide() {
  const box = realm && !realm.closed ? realm.document.getElementById("preview") : null;
  if (box) box.style.opacity = "";
  callMainSync(MODULE, "hideDragPreview");
}

function finish() {
  generation += 1;
  drag = null;
  windowPicture = null;
  pagePicture = null;
  hide();
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const mix = (from: number, to: number, e: number) => from + (to - from) * e;

function frames(ms: number, step: (eased: number) => boolean | void): Promise<boolean> {
  const started = performance.now();
  return new Promise((done) => {
    const tick = () => {
      const t = Math.min(1, (performance.now() - started) / Math.max(ms, 1));
      if (step(easeOut(t)) === false) return done(false);
      if (t >= 1) return done(true);
      setTimeout(tick, FRAME_MS);
    };
    tick();
  });
}

const nextFrame = () => new Promise<void>((done) => setTimeout(done, FRAME_MS));

function fadeOut(box: HTMLElement, mine: number): Promise<void> {
  return frames(FADE_MS, (e) => {
    if (generation !== mine) return false;
    box.style.opacity = String(1 - e);
  }).then((completed) => {
    if (completed) hide();
  });
}

function target(windowId: string | null, fallback: Rect4 | null): Target | null {
  return callMainSync<Target | null>(MODULE, "dragPreviewTarget", windowId, fallback) ?? null;
}

function wholeWindow(doc: Document): HTMLElement | null {
  if (!windowPicture) return null;
  const { image, width } = windowPicture;
  if (!pagePicture || !image.naturalWidth || !pagePicture.image.naturalWidth) return image;
  const canvas = doc.createElement("canvas");
  canvas.className = "picture";
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return image;
  const scale = image.naturalWidth / Math.max(width, 1);
  const [x, y, w, h] = pagePicture.frame;
  context.drawImage(image, 0, 0);
  context.drawImage(pagePicture.image, x * scale, y * scale, w * scale, h * scale);
  return canvas;
}

function showWholeWindow(box: HTMLElement) {
  box.className = "settle";
  box.style.opacity = "1";
  const picture = wholeWindow(box.ownerDocument);
  if (picture) box.replaceChildren(picture);
}

async function decodedPicture(url: string): Promise<HTMLImageElement | null> {
  const doc = previewWindow()?.document;
  if (!doc) return null;
  const picture = doc.createElement("img");
  picture.className = "picture";
  picture.src = url;
  await picture.decode().catch(() => {});
  return picture;
}

async function settle(windowId: string | null, fallback: Rect4 | null) {
  const mine = ++generation;
  const view = realm && !realm.closed ? realm : null;
  const box = view?.document.getElementById("preview") ?? null;
  const shown = drag !== null && drag.shape !== "hidden";
  const start = callMainSync<Bounds | null>(MODULE, "dragPreviewBounds") ?? null;
  drag = null;
  if (!view || !box || !shown || !start) return void hide();
  if (!windowId || !fallback || fallback[2] <= 0) return fadeOut(box, mine);
  const from = { x: start.x + MARGIN, y: start.y + MARGIN, width: start.width - 2 * MARGIN, height: start.height - 2 * MARGIN };
  callMainSync(MODULE, "placeDragPreview", from.x, from.y, from.width, from.height);
  showWholeWindow(box);
  windowPicture = null;
  pagePicture = null;
  let aim = target(windowId, fallback);
  for (let tries = 0; aim && !aim.found && tries < FIND_FRAMES && generation === mine; tries++) {
    await nextFrame();
    aim = target(windowId, fallback);
  }
  if (!aim || generation !== mine) return void (generation === mine && hide());
  const grown = await frames(GROW_MS, (e) => {
    if (generation !== mine) return false;
    const now = target(windowId, fallback) ?? aim!;
    const to = now.bounds;
    callMainSync(MODULE, "placeDragPreview", mix(from.x, to.x, e), mix(from.y, to.y, e), mix(from.width, to.width, e), mix(from.height, to.height, e));
  });
  if (!grown) return;
  const waitUntil = performance.now() + REVEAL_WAIT_MS;
  while (generation === mine && aim.found && !target(windowId, fallback)?.shown && performance.now() < waitUntil) await nextFrame();
  if (generation === mine) await fadeOut(box, mine);
}

let lastPoint: [number, number] = [0, 0];

export const dragPreviewModule = {
  async dragPreviewBegin(windowId: string, chip: Rect4, grab: [number, number]) {
    const mine = ++generation;
    drag = { source: windowId, chip, grab: [grab[0] - chip[0], grab[1] - chip[1]], picture: null, aspect: 16 / 10, title: "", favicon: null, shape: "hidden" };
    windowPicture = null;
    pagePicture = null;
    previewWindow();
    const snapshot = await callMain<WindowSnapshot | null>(MODULE, "snapshotWindow", windowId).catch(() => null);
    if (generation !== mine || !drag || !snapshot) return;
    const image = await decodedPicture(snapshot.url);
    if (generation === mine && drag && image) windowPicture = { image, width: snapshot.width, height: snapshot.height };
  },
  async dragPreviewPage(base64: string, frame: Rect4) {
    if (!drag) return;
    const mine = generation;
    const url = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
    drag.picture = url;
    if (frame[2] > 0 && frame[3] > 0) drag.aspect = frame[2] / frame[3];
    render(lastPoint);
    if (frame[2] <= 0 || frame[3] <= 0) return;
    const image = await decodedPicture(url);
    if (generation === mine && drag && image) pagePicture = { image, frame };
  },
  async dragPreviewPlaceholder(title: string, favicon: string | null) {
    if (!drag) return;
    drag.title = title;
    drag.favicon = favicon;
    render(lastPoint);
  },
  async dragPreviewUpdate(shape: Shape, point: [number, number]) {
    if (!drag) return;
    drag.shape = shape;
    lastPoint = point;
    render(point);
  },
  async dragPreviewEnd(windowId: string | null = null, frame: Rect4 | null = null) {
    await settle(windowId, frame);
  },
  async dragPreviewCancel() {
    finish();
  },
};
