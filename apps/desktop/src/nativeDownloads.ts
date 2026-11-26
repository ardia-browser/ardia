import type { Download } from "../../browser/src/state/downloads/actions";
import { awaitsKeep, dangerWarning, downloadStatus } from "../../browser/src/state/downloads/status";
import type { HostRect } from "./host.ts";
import type { PopoverDismissReason, PopoverHandle, PopoverSpec } from "./popoverHost.ts";

export const DOWNLOADS_ROUTE = "downloads";
export const DOWNLOADS_POPOVER = { width: 300, padding: 6, header: 28, row: 44, empty: 32, footer: 30, separator: 9, visibleRows: 8 } as const;
export const RECENT_PRESS_MS = 300;
export const OUTSIDE_SETTLE_MS = 80;
export type ButtonPress = "held" | "recent" | "none";
const PROGRESS_MIN = 0.03;
const MAX_ROWS = 50;

export const DOWNLOADS_ACTIONS = ["open", "reveal", "pause", "resume", "cancel", "keep", "discard"] as const;
export type DownloadsAction = (typeof DOWNLOADS_ACTIONS)[number];
export type DownloadsRow = { id: string; title: string; status: string; warning: boolean; missing: boolean; progress: number | null; paused: boolean; actions: DownloadsAction[] };
export type DownloadsProps = { rows: DownloadsRow[]; clearable: boolean; dark: boolean; revealTitle: string };
export type DownloadsMessage = { type: "action"; action: DownloadsAction; id: string } | { type: "clear" } | { type: "viewAll" };
export type DownloadsActions = {
  open(path: string): void;
  reveal(path: string): void;
  pause(id: string): void;
  resume(id: string): void;
  cancel(id: string): void;
  keep(id: string): void;
  clear(): void;
  viewAll(): void;
};

type Shown = Pick<Download, "id" | "filename" | "path" | "state" | "received" | "total" | "paused" | "dangerous" | "url" | "speed">;

type PointerPress = { pointerId?: number; target: EventTarget | null };

export function createButtonPresses(isButton: (target: EventTarget | null) => boolean, now: () => number, defer: (run: () => void) => void) {
  let holder: number | null = null;
  let releasedAt = Number.NEGATIVE_INFINITY;
  let waiting: (() => void)[] = [];
  const idOf = (event: PointerPress) => (typeof event.pointerId === "number" ? event.pointerId : 1);
  return {
    down(event: PointerPress) {
      if (holder === null && isButton(event.target)) holder = idOf(event);
    },
    up(event: PointerPress) {
      if (holder === null || idOf(event) !== holder) return;
      holder = null;
      releasedAt = now();
      const run = waiting;
      waiting = [];
      defer(() => run.forEach((next) => next()));
    },
    press: (): ButtonPress => (holder !== null ? "held" : now() - releasedAt <= RECENT_PRESS_MS ? "recent" : "none"),
    afterRelease(run: () => void) {
      if (holder !== null) waiting.push(run);
      else defer(run);
    },
    clear() {
      waiting = [];
    },
  };
}

export const downloadPresence = (status: (path: string) => "present" | "missing" | "unknown") => (path: string) => status(path) !== "missing";

export function downloadsRow(d: Shown, exists: (path: string) => boolean): DownloadsRow {
  const present = d.state !== "finished" || exists(d.path);
  const done = d.state === "finished" && present;
  const blocked = awaitsKeep(d);
  const downloading = d.state === "downloading";
  const actions: DownloadsAction[] = blocked ? ["keep", "discard"] : downloading ? [d.paused ? "resume" : "pause", "cancel"] : done ? ["open", "reveal"] : [];
  return {
    id: d.id,
    title: d.filename || "Preparing…",
    status: blocked ? dangerWarning(d as Download, true) : downloadStatus(d as Download, present),
    warning: blocked,
    missing: !present,
    progress: downloading && !blocked ? Math.max(PROGRESS_MIN, d.total > 0 ? Math.min(1, d.received / d.total) : 0) : null,
    paused: !!d.paused,
    actions,
  };
}

export function downloadsProps(list: readonly Shown[], exists: (path: string) => boolean, dark: boolean, revealTitle: string): DownloadsProps {
  return {
    rows: list.slice(0, MAX_ROWS).map((d) => downloadsRow(d, exists)),
    clearable: list.some((d) => d.state !== "downloading"),
    dark,
    revealTitle,
  };
}

export function downloadsPanelSize(rows: number) {
  const { width, padding, header, row, empty, footer, separator, visibleRows } = DOWNLOADS_POPOVER;
  const list = rows > 0 ? Math.min(rows, visibleRows) * row : empty;
  return { width, height: padding * 2 + header + list + separator + footer };
}

const isAction = (value: unknown): value is DownloadsAction => typeof value === "string" && (DOWNLOADS_ACTIONS as readonly string[]).includes(value);

export function downloadsMessage(raw: unknown, rows: readonly DownloadsRow[]): DownloadsMessage | null {
  const message = raw as { type?: unknown; action?: unknown; id?: unknown } | null;
  if (!message || typeof message !== "object") return null;
  if (message.type === "clear" || message.type === "viewAll") return { type: message.type };
  if (message.type !== "action" || !isAction(message.action) || typeof message.id !== "string") return null;
  const row = rows.find((candidate) => candidate.id === message.id);
  return row && row.actions.includes(message.action) ? { type: "action", action: message.action, id: message.id } : null;
}

export function runDownloadsMessage(message: DownloadsMessage, list: readonly Pick<Download, "id" | "path">[], actions: DownloadsActions, close: () => void) {
  if (message.type === "clear") {
    close();
    return actions.clear();
  }
  if (message.type === "viewAll") {
    close();
    return actions.viewAll();
  }
  const download = list.find((d) => d.id === message.id);
  if (!download) return;
  switch (message.action) {
    case "open":
      return actions.open(download.path);
    case "reveal":
      return actions.reveal(download.path);
    case "pause":
      return actions.pause(download.id);
    case "resume":
      return actions.resume(download.id);
    case "cancel":
    case "discard":
      return actions.cancel(download.id);
    case "keep":
      return actions.keep(download.id);
  }
}

export type NativeDownloadsDeps = {
  popovers: { open(spec: PopoverSpec): PopoverHandle };
  anchor(): { rect: HostRect; side: "top" | "bottom" };
  props(): DownloadsProps;
  list(): readonly Pick<Download, "id" | "path">[];
  actions: DownloadsActions;
  close(byPress: boolean): void;
  isButton(target: EventTarget | null): boolean;
  buttonPress(): ButtonPress;
  afterButtonRelease(run: () => void): void;
  later(run: () => void, ms: number): void;
  fallback(): void;
};

export function openNativeDownloads(deps: NativeDownloadsDeps) {
  let live = true;
  let fallingBack = false;
  const close = (byPress: boolean) => {
    if (live) deps.close(byPress);
  };
  const settleOutside = (settled: boolean) => {
    const press = deps.buttonPress();
    if (press === "held") return deps.afterButtonRelease(() => close(true));
    if (press === "recent") return deps.later(() => close(true), 0);
    if (settled) return close(true);
    deps.later(() => settleOutside(true), OUTSIDE_SETTLE_MS);
  };
  const onDismiss = (reason: PopoverDismissReason) => {
    if (fallingBack || reason === "replaced") return;
    if (reason === "outside") return settleOutside(false);
    close(false);
  };
  const { rect, side } = deps.anchor();
  const props = deps.props();
  const handle = deps.popovers.open({
    anchor: rect,
    size: downloadsPanelSize(props.rows.length),
    side,
    align: "center",
    content: { route: DOWNLOADS_ROUTE, props },
    ignorePress: deps.isButton,
    onDismiss,
    onMessage: (raw) => {
      const message = downloadsMessage(raw, deps.props().rows);
      if (message) runDownloadsMessage(message, deps.list(), deps.actions, () => close(false));
    },
  });
  void handle.ready.then(
    (mode) => {
      if (mode !== "dom" || !live) return;
      fallingBack = true;
      handle.close("replaced");
      deps.fallback();
    },
    () => {
      fallingBack = true;
      if (live) deps.fallback();
    },
  );
  return {
    handle,
    update() {
      if (!live || handle.closed()) return;
      const next = deps.props();
      handle.update({ props: next, size: downloadsPanelSize(next.rows.length) });
    },
    stop() {
      live = false;
      if (!handle.closed()) handle.close("closed");
    },
  };
}
