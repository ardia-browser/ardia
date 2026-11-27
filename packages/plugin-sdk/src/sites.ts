import { HOST_METHODS as M, type SiteDownloadProgress, type SiteRequest, type SiteResponseData } from "./protocol";
import { PluginError, unwrap, type Rpc } from "./rpc";
import type { Registry } from "./types";

export type SiteResponse = SiteResponseData & { text(): string; json<T = unknown>(): T };

export type SiteDownload = { id: string; done: Promise<{ size: number }>; cancel(): Promise<void> };

const EARLY_DOWNLOAD_EVENTS = 16;

export function deliverSiteDownload(registry: Registry, data: Record<string, unknown>, report: (error: unknown) => void) {
  const id = data.download;
  if (typeof id !== "string" || typeof data.state !== "string") return;
  const progress: SiteDownloadProgress = {
    download: id,
    state: data.state as SiteDownloadProgress["state"],
    received: typeof data.received === "number" ? data.received : 0,
    ...(typeof data.total === "number" ? { total: data.total } : {}),
    ...(typeof data.size === "number" ? { size: data.size } : {}),
    ...(typeof data.code === "string" ? { code: data.code } : {}),
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
  const listener = registry.sites.listeners.get(id);
  if (!listener) {
    const early = registry.sites.early.get(id) ?? [];
    if (early.length < EARLY_DOWNLOAD_EVENTS) early.push(progress);
    registry.sites.early.set(id, early);
    if (registry.sites.early.size > 32) registry.sites.early.delete(registry.sites.early.keys().next().value!);
    return;
  }
  try {
    listener(progress);
  } catch (error) {
    report(error);
  }
}

const STATUS_POLL_MS = 5000;

type Timers = { setTimeout?: (callback: () => void, ms: number) => unknown; clearTimeout?: (timer: unknown) => void };

const timers = () => globalThis as Timers;

const progressOf = (data: unknown): SiteDownloadProgress | null => {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.download !== "string" || !["running", "done", "failed", "cancelled"].includes(d.state as string)) return null;
  return {
    download: d.download,
    state: d.state as SiteDownloadProgress["state"],
    received: typeof d.received === "number" ? d.received : 0,
    ...(typeof d.total === "number" ? { total: d.total } : {}),
    ...(typeof d.size === "number" ? { size: d.size } : {}),
    ...(typeof d.code === "string" ? { code: d.code } : {}),
    ...(typeof d.error === "string" ? { error: d.error } : {}),
  };
};

export function sitesApi(rpc: Rpc, registry: Registry, report: (error: unknown) => void = () => {}) {
  return {
    async available(): Promise<boolean> {
      return unwrap(await rpc.request(M.sitesAvailable, {}), "available") === true;
    },
    async session(): Promise<string> {
      const id = unwrap(await rpc.request(M.sitesSession, {}), "session");
      if (typeof id !== "string") throw new PluginError("failed", "sites.session didn't answer a session id.");
      return id;
    },
    async fetch(url: string, init: SiteRequest = {}): Promise<SiteResponse> {
      const data = await rpc.request<SiteResponseData>(M.sitesFetch, { url, ...init });
      if (!data || typeof data.status !== "number" || typeof data.body !== "string") throw new PluginError("failed", "The site request failed.");
      return { ...data, text: () => data.body, json: <T>() => JSON.parse(data.body) as T };
    },
    async download(url: string, options: { to: string; maxBytes?: number; headers?: Record<string, string>; session?: string; onProgress?: (progress: SiteDownloadProgress) => void }): Promise<SiteDownload> {
      const res = await rpc.request<{ download?: unknown }>(M.sitesDownload, {
        url,
        to: options.to,
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.session !== undefined ? { session: options.session } : {}),
      });
      const id = unwrap(res, "download");
      if (typeof id !== "string") throw new PluginError("failed", "sites.download didn't answer a download id.");
      let poll: unknown = null;
      const done = new Promise<{ size: number }>((resolve, reject) => {
        let settled = false;
        const settle = (progress: SiteDownloadProgress) => {
          if (settled || progress.state === "running") return;
          settled = true;
          if (poll !== null) timers().clearTimeout?.(poll);
          registry.sites.listeners.delete(id);
          if (progress.state === "done") resolve({ size: progress.size ?? progress.received });
          else reject(new PluginError(progress.state === "cancelled" ? "cancelled" : (progress.code ?? "failed"), progress.error ?? (progress.state === "cancelled" ? "The download was cancelled." : "The download failed.")));
        };
        const listener = (progress: SiteDownloadProgress) => {
          settle(progress);
          try {
            options.onProgress?.(progress);
          } catch (error) {
            report(error);
          }
        };
        const check = () => {
          const start = timers().setTimeout;
          if (!start) return;
          poll = start(() => {
            if (settled) return;
            rpc.request(M.sitesStatus, { download: id }).then(
              (answer) => {
                const progress = progressOf(answer);
                if (progress) listener(progress);
                if (!settled) check();
              },
              (error: unknown) => {
                if ((error as { code?: unknown })?.code === "not_found") settle({ download: id, state: "failed", received: 0, code: "failed", error: "Ardia lost track of the download." });
                else if (!settled) check();
              },
            );
          }, STATUS_POLL_MS);
        };
        registry.sites.listeners.set(id, listener);
        const early = registry.sites.early.get(id) ?? [];
        registry.sites.early.delete(id);
        for (const progress of early) listener(progress);
        if (!settled) check();
      });
      done.catch(() => undefined);
      return { id, done, cancel: () => rpc.request(M.sitesCancel, { download: id }).then(() => undefined) };
    },
  };
}
