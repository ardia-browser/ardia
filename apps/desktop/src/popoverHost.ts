import { hostSupports, invokeHost, reportHostError, type ArdiaHost, type HostRect } from "./host.ts";
import { watchPageFocus } from "./pageFocus.ts";
import { cleanRect, deviceScale, placePopover, type Placement, type PopoverAlign, type PopoverSide } from "./popoverPlacement.ts";

export const POPOVER_OPEN_METHOD = "shell.popover.open";
export const POPOVER_UPDATE_METHOD = "shell.popover.update";
export const POPOVER_CLOSE_METHOD = "shell.popover.close";
export const POPOVER_BEYOND_WINDOW = "shell.popover.beyondWindow";
export const POPOVER_DISMISSED_EVENT = "shell.popoverDismissed";
export const POPOVER_MESSAGE_EVENT = "shell.popoverMessage";
export const POPOVER_CHILD_PANEL_METHODS = [POPOVER_OPEN_METHOD, POPOVER_UPDATE_METHOD, POPOVER_CLOSE_METHOD] as const;

export type PopoverMode = "native" | "dom";
export type PopoverDismissReason = "escape" | "outside" | "blur" | "resize" | "replaced" | "closed" | "host" | "failed" | "page";
export type PopoverCapabilities = { childPanels: boolean; beyondWindow: boolean };
export type PopoverContent = { route: string; props?: Record<string, unknown> };

export type PopoverSpec = {
  anchor: HostRect;
  size: { width: number; height: number };
  content: PopoverContent;
  side?: PopoverSide;
  align?: PopoverAlign;
  gap?: number;
  margin?: number;
  takesFocus?: boolean;
  restoreFocus?: boolean;
  nested?: boolean;
  ignorePress?: (target: EventTarget | null) => boolean;
  onDismiss?: (reason: PopoverDismissReason) => void;
  onMessage?: (message: unknown) => void;
};

export type PopoverOpenRequest = {
  id: string;
  windowId: string;
  anchor: HostRect;
  rect: HostRect;
  side: PopoverSide;
  arrowOffset: number;
  scale: number;
  beyondWindow: boolean;
  takesFocus: boolean;
  content: PopoverContent;
};
export type PopoverUpdateRequest = Omit<PopoverOpenRequest, "content" | "takesFocus" | "beyondWindow"> & { content?: Pick<PopoverContent, "props"> };
export type PopoverMessageEvent = { id: string; windowId: string; message?: unknown };
export type PopoverCloseRequest = { id: string; windowId: string; reason: PopoverDismissReason };
export type PopoverDismissedEvent = { id: string; windowId: string; reason?: PopoverDismissReason };

export type DomPopover = { element: Element; place(placement: Placement): void; update?(props: Record<string, unknown>): void; unmount(): void };
type Focusable = { focus(options?: { preventScroll?: boolean }): void; isConnected?: boolean };
type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type PopoverHostDeps = {
  windowId: string;
  capabilities: PopoverCapabilities;
  invoke(method: string, args: Record<string, unknown>): Promise<unknown>;
  onShellEvent(listener: (name: string, data: unknown) => void): () => void;
  watchPageFocus?(listener: () => void): () => void;
  windowFocused?(): boolean;
  viewport(): HostRect;
  workArea(): HostRect;
  scale(): number;
  mountDom(id: string, spec: PopoverSpec, placement: Placement): DomPopover;
  addRegion: ((element: Element) => () => void) | null;
  target: Target;
  activeElement(): Focusable | null;
  focusable?(element: Focusable): boolean;
  contains(element: Element, node: EventTarget | null): boolean;
  nextId(): string;
  report?(error: unknown): void;
};

export type PopoverHandle = {
  readonly id: string;
  mode(): PopoverMode;
  placement(): Placement;
  ready: Promise<PopoverMode>;
  update(next: Partial<Pick<PopoverSpec, "anchor" | "size" | "side" | "align">> & { props?: Record<string, unknown> }): void;
  close(reason?: PopoverDismissReason): void;
  closed(): boolean;
};

export function popoverCapabilities(host: ArdiaHost | undefined): PopoverCapabilities {
  const childPanels = !!host && POPOVER_CHILD_PANEL_METHODS.every((method) => hostSupports(method, host));
  return { childPanels, beyondWindow: childPanels && hostSupports(POPOVER_BEYOND_WINDOW, host) };
}

type Lifecycle = "opening" | "open" | "closed";

type Entry = {
  id: string;
  spec: PopoverSpec;
  mode: PopoverMode;
  placement: Placement;
  dom: DomPopover | null;
  dropRegion: (() => void) | null;
  prior: Focusable | null;
  state: Lifecycle;
  panelOpen: boolean;
  updateQueued: boolean;
  propsQueued: boolean;
  closeReason: PopoverDismissReason;
  hostDismissed: boolean;
};

const modifierFree = (event: KeyboardEvent) => !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

export function createPopoverHost(deps: PopoverHostDeps) {
  const stack: Entry[] = [];
  const opening = new Map<string, Entry>();
  let detach: (() => void) | null = null;

  const call = (method: string, args: Record<string, unknown>) => Promise.resolve().then(() => deps.invoke(method, args));
  const quietly = (method: string, args: Record<string, unknown>) => void call(method, args).catch((error) => deps.report?.(error));
  const area = (entry: Entry) => (entry.mode === "native" && deps.capabilities.beyondWindow ? deps.workArea() : deps.viewport());
  const place = (entry: Entry) =>
    placePopover({ anchor: entry.spec.anchor, size: entry.spec.size, area: area(entry), side: entry.spec.side, align: entry.spec.align, gap: entry.spec.gap, margin: entry.spec.margin, scale: deps.scale() });
  const geometry = (entry: Entry): PopoverUpdateRequest => ({
    id: entry.id,
    windowId: deps.windowId,
    anchor: cleanRect(entry.spec.anchor),
    rect: entry.placement.rect,
    side: entry.placement.side,
    arrowOffset: entry.placement.arrowOffset,
    scale: deviceScale(deps.scale()),
  });
  const closePanel = (entry: Entry) => quietly(POPOVER_CLOSE_METHOD, { id: entry.id, windowId: deps.windowId, reason: entry.closeReason } satisfies PopoverCloseRequest);

  const mountDom = (entry: Entry) => {
    entry.mode = "dom";
    entry.placement = place(entry);
    entry.dom = deps.mountDom(entry.id, entry.spec, entry.placement);
    entry.dropRegion = deps.addRegion?.(entry.dom.element) ?? null;
  };

  const focusReturns = (entry: Entry) => {
    const prior = entry.prior;
    if (entry.spec.restoreFocus === false || !prior || prior.isConnected === false) return false;
    if (deps.focusable && !safely(() => deps.focusable!(prior), false)) return false;
    const now = deps.activeElement();
    return !now || now === prior || isBody(now) || (!!entry.dom && deps.contains(entry.dom.element, now as unknown as EventTarget));
  };

  function safely<T>(run: () => T, fallback: T): T {
    try {
      return run();
    } catch (error) {
      deps.report?.(error);
      return fallback;
    }
  }

  const finish = (entry: Entry, reason: PopoverDismissReason, tellHost: boolean) => {
    if (entry.state === "closed") return;
    const wasOpening = entry.state === "opening";
    entry.state = "closed";
    entry.closeReason = reason;
    const at = stack.indexOf(entry);
    if (at >= 0) stack.splice(at, 1);
    if (entry.mode === "native" && tellHost && !wasOpening && entry.panelOpen) closePanel(entry);
    const returnFocus = focusReturns(entry);
    entry.dropRegion?.();
    entry.dropRegion = null;
    if (entry.dom) safely(() => entry.dom!.unmount(), undefined);
    entry.dom = null;
    if (returnFocus) safely(() => entry.prior!.focus({ preventScroll: true }), undefined);
    detachIfIdle();
    safely(() => entry.spec.onDismiss?.(reason), undefined);
  };

  function detachIfIdle() {
    if (stack.length || opening.size) return;
    detach?.();
    detach = null;
  }

  const closeFrom = (index: number, reason: PopoverDismissReason) => {
    for (const entry of stack.slice(Math.max(0, index)).reverse()) finish(entry, reason, true);
  };

  const attach = () => {
    if (detach) return;
    const keydown = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.key !== "Escape" || !modifierFree(key) || key.defaultPrevented || key.isComposing) return;
      const entry = stack.at(-1);
      if (!entry) return;
      key.preventDefault();
      finish(entry, "escape", true);
    };
    const pointerdown = (event: Event) => {
      for (let index = stack.length - 1; index >= 0; index--) {
        const entry = stack[index]!;
        if ((entry.dom && deps.contains(entry.dom.element, event.target)) || entry.spec.ignorePress?.(event.target)) return closeFrom(index + 1, "outside");
      }
      closeFrom(0, "outside");
    };
    const blur = () => {
      if (stack.some((entry) => entry.mode === "native")) return;
      closeFrom(0, "blur");
    };
    const resize = () => closeFrom(0, "resize");
    const pageFocused = () => closeFrom(0, "page");
    const stopPageFocus = deps.watchPageFocus?.(pageFocused) ?? (() => {});
    const stopEvents = deps.onShellEvent((name, data) => {
      if (name === POPOVER_MESSAGE_EVENT) {
        const event = data as Partial<PopoverMessageEvent> | null;
        if (!event || event.windowId !== deps.windowId || typeof event.id !== "string") return;
        const entry = stack.find((candidate) => candidate.id === event.id && candidate.mode === "native");
        if (entry) safely(() => entry.spec.onMessage?.(event.message), undefined);
        return;
      }
      if (name !== POPOVER_DISMISSED_EVENT) return;
      const event = data as Partial<PopoverDismissedEvent> | null;
      if (!event || event.windowId !== deps.windowId || typeof event.id !== "string") return;
      const index = stack.findIndex((entry) => entry.id === event.id);
      const entry = stack[index];
      if (!entry) {
        const pending = opening.get(event.id);
        if (pending) pending.hostDismissed = true;
        return;
      }
      if (entry.mode !== "native") return;
      const reason = event.reason ?? "host";
      closeFrom(index + 1, reason);
      entry.hostDismissed = true;
      entry.panelOpen = false;
      finish(entry, reason, false);
      if (reason === "blur" && deps.windowFocused && !deps.windowFocused()) closeFrom(0, "blur");
    });
    deps.target.addEventListener("keydown", keydown);
    deps.target.addEventListener("pointerdown", pointerdown, true);
    deps.target.addEventListener("blur", blur);
    deps.target.addEventListener("resize", resize);
    detach = () => {
      stopEvents();
      stopPageFocus();
      deps.target.removeEventListener("keydown", keydown);
      deps.target.removeEventListener("pointerdown", pointerdown, true);
      deps.target.removeEventListener("blur", blur);
      deps.target.removeEventListener("resize", resize);
    };
  };

  const openNative = (entry: Entry): Promise<PopoverMode> => {
    const request: PopoverOpenRequest = { ...geometry(entry), beyondWindow: deps.capabilities.beyondWindow, takesFocus: entry.spec.takesFocus !== false, content: entry.spec.content };
    opening.set(entry.id, entry);
    const settle = () => {
      opening.delete(entry.id);
      detachIfIdle();
    };
    return call(POPOVER_OPEN_METHOD, request).then(
      () => {
        settle();
        if (entry.state === "closed") {
          if (!entry.hostDismissed) closePanel(entry);
          return "native";
        }
        entry.panelOpen = true;
        entry.state = "open";
        if (entry.updateQueued) {
          entry.updateQueued = false;
          quietly(POPOVER_UPDATE_METHOD, { ...geometry(entry), ...(entry.propsQueued ? { content: { props: entry.spec.content.props ?? {} } } : {}) });
          entry.propsQueued = false;
        }
        return "native";
      },
      (error) => {
        settle();
        deps.report?.(error);
        entry.updateQueued = false;
        if (entry.state === "closed") return "native";
        entry.state = "open";
        try {
          mountDom(entry);
        } catch (mountError) {
          const at = stack.indexOf(entry);
          if (at >= 0) closeFrom(at, "failed");
          throw mountError;
        }
        return "dom";
      },
    );
  };

  return {
    capabilities: deps.capabilities,
    openCount: () => stack.length,
    open(spec: PopoverSpec): PopoverHandle {
      if (!spec.nested) closeFrom(0, "replaced");
      const id = deps.nextId();
      const active = deps.activeElement();
      const native = deps.capabilities.childPanels;
      const entry: Entry = {
        id,
        spec,
        mode: native ? "native" : "dom",
        placement: null!,
        dom: null,
        dropRegion: null,
        prior: active && !isBody(active) ? active : null,
        state: native ? "opening" : "open",
        panelOpen: false,
        updateQueued: false,
        propsQueued: false,
        closeReason: "closed",
        hostDismissed: false,
      };
      stack.push(entry);
      attach();
      let ready: Promise<PopoverMode>;
      if (native) {
        entry.placement = place(entry);
        ready = openNative(entry);
      } else {
        try {
          mountDom(entry);
          ready = Promise.resolve("dom");
        } catch (error) {
          deps.report?.(error);
          finish(entry, "failed", false);
          ready = Promise.reject(error);
        }
      }
      ready.catch(() => {});
      return {
        id,
        ready,
        mode: () => entry.mode,
        placement: () => entry.placement,
        closed: () => entry.state === "closed",
        close: (reason = "closed") => {
          const index = stack.indexOf(entry);
          if (index >= 0) closeFrom(index, reason);
        },
        update({ props, ...next }) {
          if (entry.state === "closed") return;
          entry.spec = { ...entry.spec, ...next, ...(props ? { content: { ...entry.spec.content, props } } : {}) };
          entry.placement = place(entry);
          if (entry.mode === "dom") {
            if (props) entry.dom?.update?.(props);
            entry.dom?.place(entry.placement);
          } else if (entry.state === "opening") {
            entry.updateQueued = true;
            entry.propsQueued ||= !!props;
          } else quietly(POPOVER_UPDATE_METHOD, { ...geometry(entry), ...(props ? { content: { props } } : {}) });
        },
      };
    },
    closeAll(reason: PopoverDismissReason = "closed") {
      closeFrom(0, reason);
    },
  };
}

function isBody(node: unknown) {
  const name = (node as { nodeName?: string } | null)?.nodeName;
  return name === "BODY" || name === "HTML";
}

export type PopoverHost = ReturnType<typeof createPopoverHost>;

let popoverSerial = 0;
let popoverDocument = "";
export const nextPopoverId = (windowId: string) => {
  popoverDocument ||= typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `popover-${windowId}-${popoverDocument}-${++popoverSerial}`;
};

export function focusableForRestore(element: Focusable): boolean {
  const node = element as Partial<HTMLElement>;
  if (node.isConnected === false) return false;
  if (typeof node.closest === "function" && node.closest("[inert], [aria-hidden='true']")) return false;
  if (typeof node.getClientRects === "function" && node.getClientRects().length === 0) return false;
  return true;
}

export function domPopoverDeps(host: ArdiaHost, mountDom: PopoverHostDeps["mountDom"], addRegion: PopoverHostDeps["addRegion"]): PopoverHostDeps {
  const windowId = host.bootstrap.windowId;
  return {
    windowId,
    capabilities: popoverCapabilities(host),
    invoke: (method, args) => invokeHost(method, args, host),
    onShellEvent: (listener) =>
      host.onEvent((module, event, payload) => {
        if (module !== "ArdiaShell" || event !== "shell") return;
        const envelope = payload as { name?: string; data?: unknown } | null;
        if (typeof envelope?.name === "string") listener(envelope.name, envelope.data);
      }),
    watchPageFocus,
    windowFocused: () => document.hasFocus(),
    viewport: () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }),
    workArea: () => {
      const avail = window.screen as Screen & { availLeft?: number; availTop?: number };
      return { x: (avail.availLeft ?? 0) - window.screenX, y: (avail.availTop ?? 0) - window.screenY, width: avail.availWidth, height: avail.availHeight };
    },
    scale: () => window.devicePixelRatio || 1,
    mountDom,
    addRegion,
    target: window,
    activeElement: () => document.activeElement as (HTMLElement & Focusable) | null,
    focusable: focusableForRestore,
    contains: (element, node) => node instanceof Node && element.contains(node),
    nextId: () => nextPopoverId(windowId),
    report: reportHostError,
  };
}
