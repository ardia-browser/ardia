import { useSyncExternalStore, type CSSProperties } from "react";

export type SymbolWeight = "light" | "regular" | "medium" | "semibold" | "bold";

export const SYMBOLS: Readonly<Record<string, string>> = {
  chevronRight: "chevron.right",
  chevronDown: "chevron.down",
  chevronUp: "chevron.up",
  chevronLeft: "chevron.left",
  chevronsLeft: "chevron.left.2",
  plus: "plus",
  more: "ellipsis",
  search: "magnifyingglass",
  home: "house",
  trash: "trash",
  settings: "gearshape",
  template: "square.on.square",
  page: "doc.text",
  pageEmpty: "doc",
  star: "star",
  starFilled: "star.fill",
  comment: "bubble.left",
  clock: "clock",
  lock: "lock",
  unlock: "lock.open",
  link: "link",
  copy: "doc.on.doc",
  duplicate: "plus.square.on.square",
  move: "arrow.right.doc.on.clipboard",
  arrowUpRight: "arrow.up.right",
  arrowRight: "arrow.right",
  arrowLeft: "arrow.left",
  arrowUp: "arrow.up",
  arrowDown: "arrow.down",
  restore: "arrow.uturn.backward",
  undo: "arrow.uturn.backward",
  sidebar: "sidebar.left",
  smile: "face.smiling",
  image: "photo",
  x: "xmark",
  check: "checkmark",
  text: "textformat",
  h1: "textformat.size.larger",
  h2: "textformat.size",
  h3: "textformat.size.smaller",
  bulleted: "list.bullet",
  numbered: "list.number",
  todo: "checklist",
  toggle: "chevron.right.square",
  toggleList: "list.bullet.indent",
  quote: "text.quote",
  callout: "lightbulb",
  divider: "minus",
  code: "chevron.left.forwardslash.chevron.right",
  table: "tablecells",
  video: "play.rectangle",
  audio: "waveform",
  file: "doc",
  bookmark: "bookmark",
  embed: "rectangle.on.rectangle",
  equation: "function",
  mermaid: "point.3.connected.trianglepath.dotted",
  toc: "list.bullet.rectangle",
  breadcrumb: "chevron.forward.2",
  columns: "rectangle.split.2x1",
  database: "cylinder.split.1x2",
  board: "rectangle.split.3x1",
  gallery: "square.grid.2x2",
  list: "list.bullet",
  calendar: "calendar",
  timeline: "calendar.day.timeline.leading",
  chart: "chart.bar",
  at: "at",
  date: "calendar",
  person: "person",
  people: "person.2",
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strikethrough",
  color: "paintpalette",
  export: "square.and.arrow.up",
  import: "square.and.arrow.down",
  share: "square.and.arrow.up",
  fullWidth: "arrow.left.and.right",
  font: "textformat",
  edit: "pencil",
  compose: "square.and.pencil",
  globe: "globe",
  folder: "folder",
  inbox: "tray",
  sparkle: "sparkles",
  shuffle: "shuffle",
  upload: "square.and.arrow.up",
  reposition: "arrow.up.and.down.and.arrow.left.and.right",
  enter: "return",
  wrap: "text.word.spacing",
  reply: "arrowshape.turn.up.left",
  resolve: "checkmark.circle",
  synced: "arrow.triangle.2.circlepath",
  turn: "arrow.left.arrow.right",
  alignLeft: "text.alignleft",
  filter: "line.3.horizontal.decrease",
  sort: "arrow.up.arrow.down",
  eye: "eye",
  eyeOff: "eye.slash",
  expand: "arrow.up.left.and.arrow.down.right",
  sidePeek: "sidebar.right",
  centerPeek: "rectangle.center.inset.filled",
  fullPage: "arrow.up.left.and.arrow.down.right",
  layout: "rectangle.3.group",
  group: "square.stack",
  freeze: "snowflake",
  calc: "sum",
  info: "info.circle",
  title: "textformat",
  number: "number",
  select: "chevron.down.circle",
  status: "circle.dotted",
  files: "paperclip",
  checkbox: "checkmark.square",
  url: "link",
  email: "at",
  phone: "phone",
  formula: "function",
  relation: "arrow.up.right",
  rollup: "magnifyingglass",
  id: "number",
  today: "calendar.badge.clock",
  zoom: "plus.magnifyingglass",
  multi_select: "list.bullet",
  created_by: "person.crop.circle",
  edited_by: "person.crop.circle",
  created_time: "clock",
  edited_time: "clock.arrow.circlepath",
};

const BOLDER = new Set(["chevronRight", "chevronDown", "chevronUp", "chevronLeft", "chevronsLeft", "x", "check", "plus"]);

const inArdia = typeof location !== "undefined" && location.protocol === "ardia-plugin:";
const host = inArdia ? location.host : "";

export type SymbolSupport = "checking" | "ok" | "off";

const PROBE_KEY = "notes.symbols";
let support: SymbolSupport = inArdia ? remembered() : "off";
const listeners = new Set<() => void>();

function remembered(): SymbolSupport {
  try {
    const kept = sessionStorage.getItem(PROBE_KEY);
    return kept === "ok" || kept === "off" ? kept : "checking";
  } catch {
    return "checking";
  }
}

function settle(next: SymbolSupport) {
  if (support === next) return;
  support = next;
  try {
    sessionStorage.setItem(PROBE_KEY, next);
  } catch {}
  for (const listener of listeners) listener();
}

if (inArdia) {
  void fetch(`ardia-plugin://${host}/__symbols/plus.png?size=13&weight=regular&scale=1`)
    .then((r) => settle(r.ok && (r.headers.get("content-type") ?? "").startsWith("image/") ? "ok" : "off"))
    .catch(() => settle("off"));
}

export function symbolsEnabled(): boolean {
  return support === "ok";
}

export function useSymbolSupport(): SymbolSupport {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => support,
    () => support,
  );
}

export function symbolPoints(box: number): number {
  return Math.max(6, Math.round(box * (box <= 16 ? 0.75 : 0.65) * 2) / 2);
}

const scale = typeof devicePixelRatio === "number" && devicePixelRatio > 1.5 ? 2 : 1;

export function symbolUrl(symbol: string, points: number, weight: SymbolWeight): string {
  return `ardia-plugin://${host}/__symbols/${symbol}.png?size=${points}&weight=${weight}&scale=${scale}`;
}

export function symbolOf(name: string): string | null {
  return support === "ok" ? (SYMBOLS[name] ?? "doc.text") : null;
}

export function symbolStyle(name: string, size: number, weight?: SymbolWeight, style?: CSSProperties): CSSProperties | null {
  const symbol = symbolOf(name);
  if (!symbol) return null;
  const image = `-webkit-image-set(url("${symbolUrl(symbol, symbolPoints(size), weight ?? (BOLDER.has(name) ? "semibold" : size <= 14 ? "medium" : "regular"))}") ${scale}x)`;
  return { width: size, height: size, WebkitMaskImage: image, WebkitMaskPosition: "center", WebkitMaskRepeat: "no-repeat", backgroundColor: "currentColor", flex: "none", ...style };
}
