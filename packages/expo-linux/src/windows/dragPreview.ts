import { callMainSync } from "../bridge";
import { mirrorStylesInto } from "../host/documentStyles";

type Rect4 = [number, number, number, number];
type Shape = "hidden" | "pill" | "card";
type Realm = Window & typeof globalThis;
type Drag = { source: string; chip: Rect4; grab: [number, number]; picture: string | null; aspect: number; title: string; favicon: string | null; shape: Shape };

const NAME = "ardia-drag-preview";
const MODULE = "ArdiaAppWindows";
const CARD_WIDTH = 300;
const CARD_GRAB: [number, number] = [36, 22];
const MARGIN = 18;

let realm: Realm | null = null;
let drag: Drag | null = null;

const css = `
html, body { margin: 0; background: transparent; overflow: hidden; font: 13px system-ui, sans-serif; user-select: none; }
#preview { position: absolute; inset: ${MARGIN}px; display: flex; overflow: hidden; }
#preview.pill { align-items: center; gap: 8px; padding: 0 10px; border-radius: 9px; background: rgba(255,255,255,0.96); color: #1d1d1f; box-shadow: 0 6px 18px rgba(0,0,0,0.22), 0 0 0 0.5px rgba(0,0,0,0.18); }
#preview.card { border-radius: 10px; background: #fff; box-shadow: 0 10px 28px rgba(0,0,0,0.3), 0 0 0 0.5px rgba(0,0,0,0.2); }
#preview.card img.picture { width: 100%; height: 100%; object-fit: cover; }
#preview.card .placeholder { margin: auto; display: flex; align-items: center; gap: 8px; color: #555; padding: 0 16px; }
#preview img.icon { width: 16px; height: 16px; flex: none; }
#preview .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

function finish() {
  drag = null;
  callMainSync(MODULE, "hideDragPreview");
}

let lastPoint: [number, number] = [0, 0];

export const dragPreviewModule = {
  async dragPreviewBegin(windowId: string, chip: Rect4, grab: [number, number]) {
    drag = { source: windowId, chip, grab: [grab[0] - chip[0], grab[1] - chip[1]], picture: null, aspect: 16 / 10, title: "", favicon: null, shape: "hidden" };
    previewWindow();
  },
  async dragPreviewPage(base64: string, frame: Rect4) {
    if (!drag) return;
    drag.picture = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
    if (frame[2] > 0 && frame[3] > 0) drag.aspect = frame[2] / frame[3];
    render(lastPoint);
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
  async dragPreviewEnd() {
    finish();
  },
  async dragPreviewCancel() {
    finish();
  },
};
