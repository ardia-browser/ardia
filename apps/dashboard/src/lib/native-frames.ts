const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OFFSET = /^0x[0-9a-f]{1,13}$/;

export type NativeFrame = { raw: string; image: string; uuid: string | null; offset: number | null };
export type FrameName = { symbol: string; delta: number };
export type FrameNames = Map<string, FrameName>;

type RawFrame = { function?: unknown; module?: unknown; image_offset?: unknown };

export const frameKey = (uuid: string, offset: number) => `${uuid}+${offset}`;

function parsed(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function imageUuids(imagesJson: string): Map<string, string> {
  const images = new Map<string, string>();
  const ambiguous = new Set<string>();
  const list = parsed(imagesJson);
  if (!Array.isArray(list)) return images;
  for (const entry of list as { name?: unknown; uuid?: unknown }[]) {
    const name = typeof entry?.name === "string" ? entry.name : "";
    const uuid = typeof entry?.uuid === "string" ? entry.uuid.toLowerCase() : "";
    if (!name || !UUID.test(uuid) || ambiguous.has(name)) continue;
    if (!images.has(name)) images.set(name, uuid);
    else if (images.get(name) !== uuid) {
      images.delete(name);
      ambiguous.add(name);
    }
  }
  return images;
}

export function nativeFrame(frame: RawFrame, images: Map<string, string>): NativeFrame {
  const raw = typeof frame?.function === "string" ? frame.function : "";
  const image = typeof frame?.module === "string" ? frame.module : "";
  const text = typeof frame?.image_offset === "string" ? frame.image_offset.toLowerCase() : "";
  const offset = OFFSET.test(text) ? parseInt(text, 16) : null;
  const uuid = images.get(image) ?? null;
  return { raw, image, uuid, offset: uuid && offset != null && Number.isSafeInteger(offset) ? offset : null };
}

export function frameName(frame: NativeFrame, names: FrameNames): FrameName | null {
  return frame.uuid && frame.offset != null ? (names.get(frameKey(frame.uuid, frame.offset)) ?? null) : null;
}

export function frameLabel(frame: NativeFrame, names: FrameNames): string {
  const name = frameName(frame, names);
  return name ? `${name.symbol} + ${name.delta}` : frame.raw;
}

export function unnamed(frames: NativeFrame[]): { uuid: string; offset: number }[] {
  const seen = new Map<string, { uuid: string; offset: number }>();
  for (const f of frames) if (f.uuid && f.offset != null) seen.set(frameKey(f.uuid, f.offset), { uuid: f.uuid, offset: f.offset });
  return [...seen.values()];
}
