export type ShotTile = { uri: string; top: number; height: number };

export type Shot = { id: string; uri: string; width: number; height: number; screens: number; complete: boolean; tiles: ShotTile[] };

export type SavedShot = { uri: string; width: number; height: number };

export type Crop = { top: number; bottom: number };

export type CropHandle = "top" | "bottom";

export const MAX_SHOT_SCREENS = 20;

const MAX_SIDE = 1_000_000;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CACHE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)+cache\/long-screenshots\/$/;

const CONTENT_URI = /^content:\/\/media\/[^\s?#]+$/;

const record = (raw: unknown): Record<string, unknown> | null => (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null);

const side = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_SIDE ? value : null);

function captureFolder(uri: string, id: string): string | null {
  const prefix = "file://";
  const name = `${id}/shot.png`;
  if (!uri.startsWith(prefix) || !uri.endsWith(`/${name}`)) return null;
  const path = uri.slice(prefix.length, uri.length - name.length);
  if (!CACHE_PATH.test(path) || path.split("/").some((part) => part === "." || part === "..")) return null;
  return `${prefix}${path}${id}/`;
}

function tileOf(raw: unknown, folder: string, index: number): ShotTile | null {
  const fields = record(raw);
  if (!fields || fields.uri !== `${folder}tile-${index}.jpg`) return null;
  const height = side(fields.height);
  const top = fields.top === 0 ? 0 : side(fields.top);
  return height !== null && top !== null ? { uri: fields.uri, top, height } : null;
}

export function shotOf(raw: unknown): Shot | null {
  const fields = record(raw);
  if (!fields || typeof fields.id !== "string" || !ID.test(fields.id) || typeof fields.uri !== "string" || typeof fields.complete !== "boolean") return null;
  const folder = captureFolder(fields.uri, fields.id);
  const width = side(fields.width);
  const height = side(fields.height);
  const screens = side(fields.screens);
  if (folder === null || width === null || height === null || screens === null || screens > MAX_SHOT_SCREENS || !Array.isArray(fields.tiles) || fields.tiles.length === 0) return null;
  const tiles: ShotTile[] = [];
  let next = 0;
  for (const [index, raw] of fields.tiles.entries()) {
    const tile = tileOf(raw, folder, index);
    if (!tile || tile.top !== next) return null;
    tiles.push(tile);
    next = tile.top + tile.height;
  }
  if (next !== height) return null;
  return { id: fields.id, uri: fields.uri, width, height, screens, complete: fields.complete, tiles };
}

const screensWord = (screens: number) => (screens === 1 ? "1 screen" : `${screens} screens`);

export const shotLabel = (shot: Pick<Shot, "screens" | "complete">) => {
  if (shot.complete) return screensWord(shot.screens);
  return shot.screens >= MAX_SHOT_SCREENS ? `First ${screensWord(shot.screens)}` : `Stopped after ${screensWord(shot.screens)}`;
};

export function savedShotOf(raw: unknown): SavedShot | null {
  const fields = record(raw);
  if (!fields || typeof fields.uri !== "string" || !CONTENT_URI.test(fields.uri)) return null;
  const width = side(fields.width);
  const height = side(fields.height);
  return width !== null && height !== null ? { uri: fields.uri, width, height } : null;
}

export const wholeCrop = (shot: Shot): Crop => ({ top: 0, bottom: shot.height });

export const isWholeCrop = (shot: Shot, crop: Crop) => crop.top <= 0 && crop.bottom >= shot.height;

export const minimumCropRows = (shot: Shot, displayScale: number, minimumPoints: number): number =>
  Math.min(shot.height, Math.max(1, Math.ceil(minimumPoints / (displayScale > 0 && Number.isFinite(displayScale) ? displayScale : 1))));

export function draggedCrop(shot: Shot, start: Crop, handle: CropHandle, movedPoints: number, displayScale: number, minimumRows: number): Crop {
  const scale = displayScale > 0 && Number.isFinite(displayScale) ? displayScale : 1;
  const rows = Number.isFinite(movedPoints) ? movedPoints / scale : 0;
  const least = Math.min(shot.height, Math.max(1, minimumRows));
  if (handle === "top") {
    const top = Math.round(Math.min(Math.max(0, start.top + rows), start.bottom - least));
    return { top: Math.max(0, top), bottom: start.bottom };
  }
  const bottom = Math.round(Math.max(Math.min(shot.height, start.bottom + rows), start.top + least));
  return { top: start.top, bottom: Math.min(shot.height, bottom) };
}

export const croppedRows = (crop: Crop) => crop.bottom - crop.top;
