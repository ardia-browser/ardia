import { clamp } from "../../../../../third_party/liquid-glass/engine";

const OWN_CONTROL_SLACK = 2;
const FADED_RIM_FLOOR = 0.25;

export function ownControl(host: HTMLElement): Element {
  const frame = host.parentElement ?? host;
  const box = frame.getBoundingClientRect();
  let own: Element = frame;
  for (let next = frame.parentElement; next && next !== document.body; next = next.parentElement) {
    const r = next.getBoundingClientRect();
    const same = Math.abs(r.left - box.left) <= OWN_CONTROL_SLACK && Math.abs(r.top - box.top) <= OWN_CONTROL_SLACK && Math.abs(r.width - box.width) <= 2 * OWN_CONTROL_SLACK && Math.abs(r.height - box.height) <= 2 * OWN_CONTROL_SLACK;
    if (!same) break;
    own = next;
  }
  return own;
}

export function ownOpacity(host: HTMLElement, own: Element) {
  let shown = 1;
  for (let el: Element | null = host; el && el !== document.body; el = el.parentElement) {
    const opacity = parseFloat(getComputedStyle(el).opacity);
    if (Number.isFinite(opacity)) shown *= opacity;
    if (el === own) break;
  }
  return clamp(shown, FADED_RIM_FLOOR, 1);
}

export function fixedBehind(el: Element, own: Element) {
  if (el.contains(own)) return false;
  const style = getComputedStyle(el);
  if (style.position !== "fixed") return false;
  const z = parseInt(style.zIndex, 10);
  return !(z > 0) && (el.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

export function raisedLayer(own: Element): Element | null {
  for (let el: Element | null = own; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.position !== "static" && parseInt(style.zIndex, 10) > 0) return el;
  }
  return null;
}

export function paintsOver(el: Element, own: Element, layer: Element | null) {
  if (el.contains(own) || (layer && !layer.contains(el))) return false;
  return (own.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}
