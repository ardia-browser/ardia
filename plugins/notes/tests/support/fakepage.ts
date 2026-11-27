import type { Notes } from "../../src/main/notes";
import { createBridgeClient } from "../../src/page/client/bridge";
import type { NotesClient } from "../../src/page/client/types";

type Listener = (event: { data?: unknown; detail?: unknown }) => void;

export type FakePage = { vanish(): void; dropped(): number; client: NotesClient & { saveState(): { state: string; refused: number }; onSaveState(l: (s: { state: string; refused: number }) => void): () => void }; view: string; ardia: { path: string; moveTo(path: string): void; send(value: unknown): unknown }; sent: unknown[]; received: unknown[]; close(): void; deliver(message: unknown): void; maxSent: number };

export function pageHub(options: { nativeLimit?: boolean; pageBucket?: { burst: number; perSecond: number } } = {}) {
  const pages = new Map<string, FakePage & { listeners: Map<string, Set<Listener>> }>();
  let notes: Notes | null = null;
  const post = async (view: string, message: unknown) => {
    const page = pages.get(view);
    const json = JSON.stringify(message);
    if (Buffer.byteLength(json) > 256 * 1024) throw Object.assign(new Error("too big"), { code: "too_large" });
    if (!page) throw Object.assign(new Error("gone"), { code: "refused" });
    setTimeout(() => page.deliver(JSON.parse(json)), 1);
  };
  const open = (view: string, openOptions: { storage?: Map<string, string>; quotaBytes?: number; bridge?: Record<string, unknown>; dropUps?: number } = {}): FakePage => {
    const ardiaListeners = new Map<string, Set<Listener>>();
    const winListeners = new Map<string, Set<Listener>>();
    const add = (map: Map<string, Set<Listener>>) => (type: string, l: Listener) => {
      let set = map.get(type);
      if (!set) map.set(type, (set = new Set()));
      set.add(l);
    };
    const fire = (map: Map<string, Set<Listener>>, type: string, event: { data?: unknown; detail?: unknown }) => {
      for (const l of [...(map.get(type) ?? [])]) l(event);
    };
    let path = "/";
    let windowStart = -Infinity;
    let windowCount = 0;
    let dropped = 0;
    const bucket = options.pageBucket ? { tokens: options.pageBucket.burst, at: performance.now() } : null;
    const page = {
      view,
      sent: [] as unknown[],
      received: [] as unknown[],
      maxSent: 0,
      dropped: () => dropped,
      listeners: ardiaListeners,
      client: null as unknown as NotesClient,
      deliver(message: unknown) {
        page.received.push(message);
        fire(ardiaListeners, "message", { data: message });
      },
      close() {
        fire(winListeners, "pagehide", {});
        pages.delete(view);
      },
      vanish() {
        pages.delete(view);
      },
    };
    const ardia = {
      send(value: unknown) {
        const json = JSON.stringify(value);
        const size = Buffer.byteLength(json);
        page.maxSent = Math.max(page.maxSent, size);
        if (size > 64 * 1024) throw new Error(`page sent ${size} bytes`);
        if (bucket && options.pageBucket) {
          const now = performance.now();
          bucket.tokens = Math.min(options.pageBucket.burst, bucket.tokens + ((now - bucket.at) * options.pageBucket.perSecond) / 1000);
          bucket.at = now;
          if (bucket.tokens < 1) return false;
          bucket.tokens -= 1;
        }
        if (options.nativeLimit) {
          const now = performance.now() / 1000;
          if (now - windowStart >= 1) {
            windowStart = now;
            windowCount = 0;
          }
          windowCount++;
          if (windowCount > 100) {
            dropped++;
            return;
          }
        }
        page.sent.push(value);
        if (!pages.has(view)) return;
        if ((value as { t?: string }).t === "up" && (openOptions.dropUps ?? 0) > 0) {
          openOptions.dropUps!--;
          return true;
        }
        setTimeout(() => notes?.onPageMessage(JSON.parse(json), view), 1);
        return true;
      },
      addEventListener: add(ardiaListeners),
      get path() {
        return path;
      },
      navigate(next: string) {
        setTimeout(() => {
          path = next;
          fire(ardiaListeners, "navigate", {});
        }, 1);
      },
      moveTo(next: string) {
        path = next;
        fire(ardiaListeners, "navigate", {});
      },
    };
    const win = {
      addEventListener: add(winListeners),
      location: { hash: "" },
      history: { pushState() {}, replaceState() {} },
      document: { title: "" },
      localStorage: (() => {
        const store = openOptions.storage ?? new Map<string, string>();
        return {
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: (k: string, v: string) => {
            if (openOptions.quotaBytes !== undefined) {
              let total = String(v).length + k.length;
              for (const [key, value] of store) if (key !== k) total += key.length + value.length;
              if (total > openOptions.quotaBytes) throw Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" });
            }
            store.set(k, String(v));
          },
          removeItem: (k: string) => void store.delete(k),
          key: (i: number) => [...store.keys()][i] ?? null,
          get length() {
            return store.size;
          },
        };
      })(),
    };
    (page as unknown as { ardia: typeof ardia }).ardia = ardia;
    pages.set(view, page);
    page.client = createBridgeClient({ ardia, window: win as never, ...(options.nativeLimit ? {} : { rate: 1000 }), ...(openOptions.bridge ?? {}) });
    return page;
  };
  return {
    post,
    open,
    attach(n: Notes) {
      notes = n;
    },
    pages,
  };
}
