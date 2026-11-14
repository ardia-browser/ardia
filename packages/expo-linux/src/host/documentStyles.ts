import { LINUX_UI_FONT_STACK } from "./uiFont";

const OWN_SHEET = "react-native-stylesheet";
const BASE_ID = "ardia-linux-base";
const MIRROR = "data-ardia-mirror";

const LINUX_MONO = ["DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono", "Noto Mono", "Ubuntu Mono", "Cousine"];
const MAC_MONO = ["Menlo", "SF Mono", "Monaco"];
const monoFaces = (weight: 400 | 700) =>
  MAC_MONO.map((family) => `@font-face { font-family: "${family}"; font-weight: ${weight}; src: ${LINUX_MONO.map((name) => `local("${weight === 700 ? `${name} Bold` : name}")`).join(", ")}; }`).join("\n");

const BASE_CSS = `
${monoFaces(400)}
${monoFaces(700)}
html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { font-family: ${LINUX_UI_FONT_STACK}; -webkit-font-smoothing: antialiased; cursor: default; user-select: none; }
#root { display: flex; position: relative; }
input:focus, textarea:focus, [tabindex]:focus { outline: none; }
input, textarea { user-select: text; }
webview { display: flex; }
html[data-ardia-shape="round"] #root { border-radius: 12px; overflow: hidden; }
html[data-ardia-shape="round"] #root::after { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 2147483647; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.14); }
html[data-ardia-shape="round"][data-ardia-dark="true"] #root::after { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
`;

const mirrored = new Set<Document>();
let mirrorNumber = 0;
let watching = false;

const isMirrorable = (node: Node): node is HTMLStyleElement | HTMLLinkElement =>
  (node.nodeName === "STYLE" && (node as Element).id !== OWN_SHEET) || (node.nodeName === "LINK" && (node as HTMLLinkElement).rel === "stylesheet");

function keyOf(node: Element): string {
  let key = node.getAttribute(MIRROR);
  if (!key) {
    key = String(++mirrorNumber);
    node.setAttribute(MIRROR, key);
  }
  return key;
}

function copyInto(target: Document, node: HTMLStyleElement | HTMLLinkElement) {
  const key = keyOf(node);
  const existing = target.head.querySelector(`[${MIRROR}="${key}"]`);
  const copy = target.importNode(node, true) as Element;
  if (node.nodeName === "LINK") copy.setAttribute("href", (node as HTMLLinkElement).href);
  if (existing) existing.replaceWith(copy);
  else target.head.appendChild(copy);
}

function removeFrom(target: Document, node: Element) {
  const key = node.getAttribute(MIRROR);
  if (key) target.head.querySelector(`[${MIRROR}="${key}"]`)?.remove();
}

function watchHostHead() {
  if (watching) return;
  watching = true;
  new MutationObserver((records) => {
    const live = [...mirrored].filter((target) => target.defaultView && !target.defaultView.closed);
    for (const record of records) {
      const changed = record.target.nodeType === Node.ELEMENT_NODE ? (record.target as Element) : record.target.parentElement;
      if (changed && changed !== document.head && isMirrorable(changed)) for (const target of live) copyInto(target, changed);
      for (const node of record.addedNodes) if (isMirrorable(node)) for (const target of live) copyInto(target, node);
      for (const node of record.removedNodes) if (node.nodeType === Node.ELEMENT_NODE) for (const target of live) removeFrom(target, node as Element);
    }
  }).observe(document.head, { childList: true, subtree: true, characterData: true });
}

export function installBaseStyles(target: Document = document) {
  if (target.getElementById(BASE_ID)) return;
  const style = target.createElement("style");
  style.id = BASE_ID;
  style.textContent = BASE_CSS;
  target.head.prepend(style);
}

export function mirrorStylesInto(target: Document) {
  watchHostHead();
  mirrored.add(target);
  installBaseStyles(target);
  for (const node of document.head.children) if (isMirrorable(node) && node.id !== BASE_ID) copyInto(target, node);
}

export function stopMirroring(target: Document) {
  mirrored.delete(target);
}
