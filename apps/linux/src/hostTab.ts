import type { ArdiaHost } from "./host";
import { enqueueTab } from "./hostTabQueue.ts";
import { queueTabPresentation } from "./hostTabPresentations.ts";
import { hostProfile, hostSupports, invokeHost } from "./host.ts";
import { consentToken } from "../../browser/src/state/telemetry/client";
import { errorFor } from "../../browser/src/state/telemetry/logs";

export type HostTabEvent = { type: string; [key: string]: unknown };
export type HostTabIdentity = { browserId: number; chromeTabId: number; state?: unknown };
export type HostTabOptions = { key: string; profile?: string; url?: string; adoptId?: string; temporary?: boolean };
export type HostPageReceiver = {
  receive(module: string, id: string, payload: unknown): boolean;
  install(value: unknown): boolean;
  captureRequest(): (() => boolean) | null;
  dispose(): void;
};
export type HostPageFactory = (claim: string, nativeId: () => number | undefined,
  rebound: (identity: { browserId: number; chromeTabId: number }) => void) => HostPageReceiver;
export type TabViewport = { rect: { x: number; y: number; width: number; height: number }; visible: boolean };

const claims = new WeakMap<ArdiaHost, Map<string, HostTab>>();
const CREATING_LOAD_MS = 2_000;
const ADOPTED_LIVE = ["tab", "ardiacore"];
const ADOPTED_AS_COPIES = ["restore", "clone"];

export function nativeAdoptId(adoptId: string | undefined, host: ArdiaHost): string | undefined {
  const kind = adoptId?.slice(0, Math.max(0, adoptId.indexOf(":")));
  if (!adoptId || !kind) return undefined;
  if (ADOPTED_LIVE.includes(kind)) return adoptId;
  return ADOPTED_AS_COPIES.includes(kind) && hostSupports("tab.adoptCopies", host) ? adoptId : undefined;
}
const UNORDERED_COMMANDS = new Set(["downloadFavicon", "webStoreRequest"]);

export class HostTab {
  host: ArdiaHost;
  key: string;
  claim = crypto.randomUUID();
  ready: Promise<HostTabIdentity>;
  identity: HostTabIdentity | undefined;
  disposed = false;
  unsubscribe: () => void;
  lastViewport = "";
  nextViewport: TabViewport | undefined;
  viewportSend: Promise<void> | undefined;
  releaseScheduled = false;
  page: HostPageReceiver | undefined;

  creating: { url: string; at: number } | null;
  now: () => number;

  constructor(host: ArdiaHost, options: HostTabOptions, onEvent: (event: HostTabEvent) => void, page?: HostPageFactory, now: () => number = Date.now) {
    this.host = host;
    this.key = options.key;
    this.now = now;
    this.creating = { url: options.url ?? "about:blank", at: now() };
    this.page = page?.(this.claim, () => this.identity?.browserId, (identity) => {
      if (this.disposed || !this.identity || claims.get(host)?.get(this.key) !== this) return;
      this.identity = { ...this.identity, browserId: identity.browserId, chromeTabId: identity.chromeTabId };
      this.lastViewport = "";
    });
    const owners = claims.get(host) ?? new Map<string, HostTab>();
    claims.set(host, owners);
    const early: { id: string; event: HostTabEvent }[] = [];
    const deliver = (event: HostTabEvent) => {
      try { onEvent(event); } catch (error) { console.error("[ardia host] tab listener failed", error); }
    };
    this.unsubscribe = host.onEvent((module, id, payload) => {
      if (this.disposed || (this.identity && owners.get(this.key) !== this)) return;
      if (this.page) {
        this.page.receive(module, id, payload);
        return;
      }
      if (module !== "ArdiaWebView" || !payload || typeof payload !== "object" || !("type" in payload)) return;
      const event = payload as HostTabEvent;
      if (!this.identity) {
        if (early.length === 128) early.shift();
        early.push({ id, event });
      } else if (id === String(this.identity.browserId)) deliver(event);
    });
    this.ready = enqueueTab(host, this.key, async () => {
      const previousClaim = owners.get(this.key)?.claim;
      const identity = await invokeHost<HostTabIdentity>("tab.create", {
        ...options, adoptId: nativeAdoptId(options.adoptId, host), claim: this.claim, ...(previousClaim ? { previousClaim } : {}), profile: hostProfile(options.profile, host), url: options.url ?? "about:blank",
      }, host);
      if (!Number.isInteger(identity?.browserId) || identity.browserId <= 0 || !Number.isInteger(identity.chromeTabId) || identity.chromeTabId <= 0) throw new Error("Invalid Ardia tab identity");
      this.identity = identity;
      owners.set(this.key, this);
      if (this.disposed) this.detach();
      else if (owners.get(this.key) === this && this.page) {
        if (!this.page.install(identity)) {
          this.page.dispose();
          this.disposed = true;
          this.unsubscribe();
          this.detach();
          throw new Error("Invalid Ardia page lease");
        }
        deliver({ type: "ready", browserId: identity.browserId, chromeTabId: identity.chromeTabId });
      } else if (owners.get(this.key) === this) {
        deliver({ type: "ready", ...identity });
        if (identity.state) deliver({ type: "navigation", state: identity.state });
        for (const queued of early) if (queued.id === String(identity.browserId) && queued.event.type !== "ready") deliver(queued.event);
      }
      early.length = 0;
      return identity;
    }).catch((error) => {
      early.length = 0;
      this.unsubscribe();
      if (owners.get(this.key) === this && !this.releaseScheduled) owners.delete(this.key);
      throw error;
    });
  }

  repeatsCreate(url: string) {
    const creating = this.creating;
    this.creating = null;
    return !!creating && creating.url === url && this.now() - creating.at < CREATING_LOAD_MS;
  }


  async command<T = unknown>(command: string, args: unknown[] = []): Promise<T> {
    await this.ready;
    const send = async () => {
      if (this.disposed || !this.identity || claims.get(this.host)?.get(this.key) !== this) throw new Error(`Ardia tab released: ${this.key}`);
      return invokeHost<T>("tab.command", { id: this.identity.browserId, claim: this.claim, command, args }, this.host);
    };
    return UNORDERED_COMMANDS.has(command) ? send() : enqueueTab(this.host, this.key, send);
  }

  async pageResult<T = unknown>(command: string, args: unknown[] = []): Promise<T | null> {
    await this.ready;
    const current = this.disposed ? null : this.page?.captureRequest() ?? null;
    if (!current) return null;
    const result = await this.command<T>(command, args);
    return current() ? result : null;
  }

  presentation(visible: boolean): Promise<void> {
    return queueTabPresentation(this, visible, () => claims.get(this.host)?.get(this.key) === this);
  }

  viewport(viewport: TabViewport): Promise<void> {
    this.nextViewport = viewport;
    return this.viewportSend ??= enqueueTab(this.host, this.key, async () => {
      this.viewportSend = undefined;
      const latest = this.nextViewport;
      this.nextViewport = undefined;
      if (!latest || this.disposed || !this.identity || claims.get(this.host)?.get(this.key) !== this) return;
      const json = JSON.stringify(latest);
      if (json === this.lastViewport) return;
      this.lastViewport = json;
      return invokeHost<void>("tab.viewport", { id: this.identity.browserId, claim: this.claim, ...latest }, this.host).catch((error) => {
        if (this.lastViewport === json) this.lastViewport = "";
        throw error;
      });
    });
  }

  shownViewport(): TabViewport | undefined {
    if (!this.lastViewport || this.nextViewport || this.viewportSend) return undefined;
    const viewport = JSON.parse(this.lastViewport) as TabViewport;
    return viewport.visible ? viewport : undefined;
  }

  presentsNow() {
    return !this.disposed && !!this.identity && !this.viewportSend && claims.get(this.host)?.get(this.key) === this;
  }

  detach() {
    if (this.releaseScheduled) return;
    this.releaseScheduled = true;
    const consent = consentToken();
    void enqueueTab(this.host, this.key, async () => {
      const owners = claims.get(this.host);
      if (!this.identity || owners?.get(this.key) !== this) return;
      await invokeHost("tab.release", { id: this.identity.browserId, claim: this.claim }, this.host);
      if (owners.get(this.key) === this) owners.delete(this.key);
    }).catch((error) => {
      this.releaseScheduled = false;
      errorFor(consent, "[ardia host] release failed", error);
    });
  }

  dispose() {
    this.disposed = true;
    this.page?.dispose();
    this.unsubscribe();
    this.detach();
  }
}

export function showInPlaceOf(from: HostTab, to: HostTab): boolean {
  const viewport = from.shownViewport();
  if (!viewport || from.host !== to.host || !from.presentsNow() || !to.presentsNow() || to.shownViewport()) return false;
  const shown: TabViewport = { rect: viewport.rect, visible: true };
  const hidden: TabViewport = { rect: viewport.rect, visible: false };
  const send = (method: string, args: Record<string, unknown>, undo: () => void) => {
    const consent = consentToken();
    void new Promise((resolve) => resolve(to.host.invoke(method, args))).catch((error: unknown) => {
      undo();
      errorFor(consent, "[ardia host] early tab switch failed", error);
    });
  };
  to.lastViewport = JSON.stringify(shown);
  from.lastViewport = JSON.stringify(hidden);
  const toId = to.identity!.browserId;
  const fromId = from.identity!.browserId;
  send("tab.presentations", { tabs: [{ id: toId, claim: to.claim, visible: true }, { id: fromId, claim: from.claim, visible: false }] }, () => {});
  send("tab.viewport", { id: toId, claim: to.claim, ...shown }, () => { if (to.lastViewport === JSON.stringify(shown)) to.lastViewport = ""; });
  send("tab.viewport", { id: fromId, claim: from.claim, ...hidden }, () => { if (from.lastViewport === JSON.stringify(hidden)) from.lastViewport = ""; });
  return true;
}
