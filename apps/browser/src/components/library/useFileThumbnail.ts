import { createContext, useContext, useEffect, useState } from "react";
import { Image } from "react-native";
import { fileThumbnail, imageSize } from "../../state/app/system";
import type { Download } from "../../state/downloads/actions";
import { onThumbnailsForgotten } from "../../state/app/thumbnails";
import { consentToken } from "../../state/telemetry/client";
import { noteLibraryThumbnail } from "../../state/telemetry/libraryCounts";
import { sharperPoints, validSize, type PixelSize } from "./thumbnailFit";

const MAX_THUMBNAILS = 256;
const MAX_SIZES = 512;
const FAILURE_RETRY_MS = 30_000;

export type Thumb = { uri: string; width: number; height: number };

type Cached<T> = { value: T | null; at: number; path: string };
type Watched = Pick<Download, "id" | "path" | "received" | "offTheRecord">;
type Load<T> = (key: string, path: string, arg: number, ephemeral: boolean) => Promise<T | null>;

function lruCache<T>(limit: number, load: Load<T>) {
  const cache = new Map<string, Cached<T>>();
  const pending = new Map<string, { path: string; request: Promise<T | null> }>();
  const get = (key: string, now: number): Cached<T> | undefined => {
    const hit = cache.get(key);
    if (!hit) return undefined;
    cache.delete(key);
    if (hit.value === null && now - hit.at >= FAILURE_RETRY_MS) return undefined;
    cache.set(key, hit);
    return hit;
  };
  const fetch = (key: string, path: string, arg: number, ephemeral: boolean): Promise<T | null> => {
    const asked = pending.get(key);
    if (asked) return asked.request;
    const request = load(key, path, arg, ephemeral).catch(() => null);
    pending.set(key, { path, request });
    void request.then((value) => {
      if (pending.get(key)?.request !== request) return;
      pending.delete(key);
      cache.delete(key);
      cache.set(key, { value, at: Date.now(), path });
      while (cache.size > limit) cache.delete(cache.keys().next().value!);
    });
    return request;
  };
  const forget = (paths: ReadonlySet<string> | null) => {
    for (const [key, hit] of cache) if (!paths || paths.has(hit.path)) cache.delete(key);
    for (const [key, asked] of pending) if (!paths || paths.has(asked.path)) pending.delete(key);
  };
  return { get, fetch, forget };
}

function useCached<T>(store: ReturnType<typeof lruCache<T>>, key: string, path: string, arg: number, on: boolean, ephemeral = false): T | null {
  const [shown, setShown] = useState<{ key: string; value: T | null }>(() => ({ key, value: on ? (store.get(key, Date.now())?.value ?? null) : null }));
  useEffect(() => {
    if (!on) return;
    const hit = store.get(key, Date.now());
    if (hit) return setShown({ key, value: hit.value });
    let live = true;
    void store.fetch(key, path, arg, ephemeral).then((value) => live && setShown({ key, value }));
    return () => {
      live = false;
    };
  }, [key, on]);
  if (!on) return null;
  if (shown.key === key) return shown.value;
  return store.get(key, Date.now())?.value ?? null;
}

const thumbnailSize = (uri: string) =>
  new Promise<PixelSize | null>((resolve) => Image.getSize(uri, (width, height) => resolve({ width, height }), () => resolve(null)));

async function renderThumb(path: string, points: number, ephemeral: boolean): Promise<Thumb | null> {
  const uri = await fileThumbnail(path, points, ephemeral);
  if (!uri) return null;
  const size = await thumbnailSize(uri);
  return size && validSize(size) ? { uri, ...size } : null;
}

async function loadThumb(path: string, points: number, ephemeral: boolean): Promise<Thumb | null> {
  const consent = consentToken();
  const started = Date.now();
  const thumb = await renderThumb(path, points, ephemeral);
  const sharper = thumb && sharperPoints(points, thumb);
  const shown = thumb && sharper ? ((await renderThumb(path, sharper, ephemeral)) ?? thumb) : thumb;
  noteLibraryThumbnail(Date.now() - started, !!shown, !!sharper, consent);
  return shown;
}

const largestThumbs = new Map<string, { points: number; thumb: Thumb }>();
const fileKey = (d: Watched) => `${d.path}#${d.id}:${d.received}`;

function rememberLargest(file: string, points: number, thumb: Thumb | null) {
  const known = largestThumbs.get(file);
  if (!thumb || (known && known.points >= points)) return;
  largestThumbs.delete(file);
  largestThumbs.set(file, { points, thumb });
  while (largestThumbs.size > MAX_THUMBNAILS) largestThumbs.delete(largestThumbs.keys().next().value!);
}

const thumbs = lruCache<Thumb>(MAX_THUMBNAILS, async (key, path, points, ephemeral) => {
  const thumb = await loadThumb(path, points, ephemeral);
  rememberLargest(key.slice(key.indexOf("|") + 1), points, thumb);
  return thumb;
});
const sizes = lruCache<PixelSize>(MAX_SIZES, async (_key, path) => {
  const size = await imageSize(path);
  return validSize(size) ? { width: size.width, height: size.height } : null;
});

const pathOfFileKey = (key: string) => key.slice(0, key.lastIndexOf("#"));

onThumbnailsForgotten((paths) => {
  const gone = paths && new Set(paths);
  thumbs.forget(gone);
  sizes.forget(gone);
  for (const key of [...largestThumbs.keys()]) if (!gone || gone.has(pathOfFileKey(key))) largestThumbs.delete(key);
});

export const ThumbnailsWantedContext = createContext(true);

export const thumbnailKey = (d: Watched, points: number) => `${points}|${fileKey(d)}`;

export function useFileThumb(d: Watched, points: number, asked: boolean): Thumb | null {
  const wanted = useContext(ThumbnailsWantedContext) && asked;
  const larger = largestThumbs.get(fileKey(d));
  const reuse = !!larger && larger.points >= points;
  const own = useCached(thumbs, thumbnailKey(d, points), d.path, points, wanted && !!d.path && !reuse, !!d.offTheRecord);
  if (!wanted || !d.path) return null;
  return reuse ? larger.thumb : own;
}

export function useFileThumbnail(d: Watched, points: number, wanted: boolean): string | null {
  return useFileThumb(d, points, wanted)?.uri ?? null;
}

export function useImageSize(d: Watched, wanted: boolean): PixelSize | null {
  return useCached(sizes, fileKey(d), d.path, 0, wanted && !!d.path);
}
