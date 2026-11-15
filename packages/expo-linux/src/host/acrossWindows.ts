type Added = { type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions };
type Target = "window" | "document";
type Realm = Window & typeof globalThis;

const FOLLOWS_WINDOWS = /^(key|pointer|mouse|touch|drag|drop|composition|focus|blur|wheel|click|dblclick|auxclick|contextmenu|resize|scroll|select|copy|cut|paste|input|beforeinput|visibilitychange|gotpointercapture|lostpointercapture)/;
const CROSS_REALM_CONSTRUCTORS = ["Node", "Event", "EventTarget"] as const;

const hostWindow = window as Realm;
const hostDocument = document;
const appWindows = new Set<Realm>();
const added: Record<Target, Added[]> = { window: [], document: [] };
let focused: Realm | null = null;
let lastFocused: Realm | null = null;
let installed = false;
const adoptionListeners = new Set<(realm: Realm) => void>();

const captures = (options?: boolean | EventListenerOptions) => (typeof options === "boolean" ? options : !!options?.capture);
const targetIn = (realm: Realm, target: Target): EventTarget => (target === "window" ? realm : realm.document);
const openWindows = () => [...appWindows].filter((realm) => !realm.closed);

export const appWindowRealms = (): Realm[] => openWindows();
export const focusedAppWindow = (): Realm | null => (focused && !focused.closed ? focused : null);
export const lastFocusedAppWindow = (): Realm | null => focusedAppWindow() ?? (lastFocused && !lastFocused.closed ? lastFocused : null) ?? openWindows()[0] ?? null;

function patchListeners(target: Target) {
  const host = targetIn(hostWindow, target);
  const add = host.addEventListener.bind(host);
  const remove = host.removeEventListener.bind(host);
  host.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
    add(type, listener, options);
    if (!listener || !FOLLOWS_WINDOWS.test(type)) return;
    added[target].push({ type, listener, options });
    for (const realm of openWindows()) targetIn(realm, target).addEventListener(type, listener, options);
  };
  host.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
    remove(type, listener, options);
    if (!listener) return;
    const list = added[target];
    const index = list.findIndex((entry) => entry.type === type && entry.listener === listener && captures(entry.options) === captures(options));
    if (index < 0) return;
    list.splice(index, 1);
    for (const realm of openWindows()) targetIn(realm, target).removeEventListener(type, listener, options);
  };
}

function patchDocumentState() {
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(hostDocument)) as Document;
  const activeElement = Object.getOwnPropertyDescriptor(proto, "activeElement")?.get;
  Object.defineProperty(hostDocument, "activeElement", {
    configurable: true,
    get: () => lastFocusedAppWindow()?.document.activeElement ?? activeElement?.call(hostDocument) ?? null,
  });
  Object.defineProperty(hostDocument, "visibilityState", { configurable: true, get: () => (openWindows().some((realm) => realm.document.visibilityState === "visible") ? "visible" : "hidden") });
  Object.defineProperty(hostDocument, "hidden", { configurable: true, get: () => hostDocument.visibilityState === "hidden" });
  hostDocument.hasFocus = () => !!focusedAppWindow()?.document.hasFocus();
  const getSelection = hostWindow.getSelection.bind(hostWindow);
  hostWindow.getSelection = () => lastFocusedAppWindow()?.getSelection() ?? getSelection();
}

function patchInstanceChecks() {
  const plain = Function.prototype[Symbol.hasInstance];
  for (const name of CROSS_REALM_CONSTRUCTORS) {
    const constructor = hostWindow[name] as unknown as { name: string };
    Object.defineProperty(constructor, Symbol.hasInstance, {
      configurable: true,
      value(this: { name: string }, value: unknown) {
        if (plain.call(this, value)) return true;
        if (typeof value !== "object" || value === null) return false;
        for (const realm of openWindows()) {
          const there = (realm as unknown as Record<string, unknown>)[this.name];
          if (typeof there === "function" && plain.call(there, value)) return true;
        }
        return false;
      },
    });
  }
}

const realmOf = (target: Element): Realm => (target.ownerDocument?.defaultView ?? hostWindow) as Realm;

function patchObservers() {
  const HostResize = hostWindow.ResizeObserver;
  const HostIntersection = hostWindow.IntersectionObserver;

  class ResizeAcrossWindows {
    private readonly inner = new Map<Realm, ResizeObserver>();
    constructor(private readonly callback: ResizeObserverCallback) {}
    private observerIn(target: Element) {
      const realm = realmOf(target);
      let observer = this.inner.get(realm);
      if (!observer) {
        const Native = realm === hostWindow ? HostResize : realm.ResizeObserver;
        observer = new Native((entries) => this.callback(entries, this as unknown as ResizeObserver));
        this.inner.set(realm, observer);
      }
      return observer;
    }
    observe(target: Element, options?: ResizeObserverOptions) {
      this.observerIn(target).observe(target, options);
    }
    unobserve(target: Element) {
      this.inner.get(realmOf(target))?.unobserve(target);
    }
    disconnect() {
      for (const observer of this.inner.values()) observer.disconnect();
      this.inner.clear();
    }
  }

  class IntersectionAcrossWindows {
    private readonly inner = new Map<Realm, IntersectionObserver>();
    constructor(
      private readonly callback: IntersectionObserverCallback,
      private readonly options?: IntersectionObserverInit,
    ) {}
    private observerIn(target: Element) {
      const realm = realmOf(target);
      let observer = this.inner.get(realm);
      if (!observer) {
        const Native = realm === hostWindow ? HostIntersection : realm.IntersectionObserver;
        observer = new Native((entries) => this.callback(entries, this as unknown as IntersectionObserver), this.options);
        this.inner.set(realm, observer);
      }
      return observer;
    }
    observe(target: Element) {
      this.observerIn(target).observe(target);
    }
    unobserve(target: Element) {
      this.inner.get(realmOf(target))?.unobserve(target);
    }
    disconnect() {
      for (const observer of this.inner.values()) observer.disconnect();
      this.inner.clear();
    }
    takeRecords() {
      return [...this.inner.values()].flatMap((observer) => observer.takeRecords());
    }
  }

  hostWindow.ResizeObserver = ResizeAcrossWindows as unknown as typeof ResizeObserver;
  hostWindow.IntersectionObserver = IntersectionAcrossWindows as unknown as typeof IntersectionObserver;
}

export function installAcrossWindows() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  patchListeners("window");
  patchListeners("document");
  patchDocumentState();
  patchInstanceChecks();
  patchObservers();
}

export function onAppWindowAdopted(listener: (realm: Realm) => void): void {
  adoptionListeners.add(listener);
  for (const realm of openWindows()) listener(realm);
}

export function adoptAppWindow(realm: Realm) {
  appWindows.add(realm);
  for (const listener of adoptionListeners) listener(realm);
  for (const target of ["window", "document"] as const)
    for (const { type, listener, options } of added[target]) targetIn(realm, target).addEventListener(type, listener, options);
  realm.addEventListener("focus", () => {
    focused = realm;
    lastFocused = realm;
  });
  realm.addEventListener("blur", () => {
    if (focused === realm) focused = null;
  });
  if (realm.document.hasFocus()) {
    focused = realm;
    lastFocused = realm;
  }
  lastFocused ??= realm;
}

export function forgetAppWindow(realm: Realm) {
  appWindows.delete(realm);
  if (focused === realm) focused = null;
  if (lastFocused === realm) lastFocused = null;
}
