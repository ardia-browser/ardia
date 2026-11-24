const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OFFSET = /^0x[0-9a-f]{1,13}$/;
const IMAGE = /^[A-Za-z0-9 ._()+-]{1,64}$/;

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export function imageUuids(imagesJson) {
  const images = new Map();
  const ambiguous = new Set();
  const list = typeof imagesJson === "string" ? parse(imagesJson) : imagesJson;
  if (!Array.isArray(list)) return images;
  for (const entry of list) {
    const name = typeof entry?.name === "string" ? entry.name : "";
    const uuid = typeof entry?.uuid === "string" ? entry.uuid.toLowerCase() : "";
    if (!IMAGE.test(name) || !UUID.test(uuid) || ambiguous.has(name)) continue;
    if (!images.has(name)) images.set(name, uuid);
    else if (images.get(name) !== uuid) {
      images.delete(name);
      ambiguous.add(name);
    }
  }
  return images;
}

export function frameOffset(frame) {
  const text = typeof frame?.image_offset === "string" ? frame.image_offset.toLowerCase() : "";
  if (!OFFSET.test(text)) return null;
  const offset = parseInt(text, 16);
  return Number.isSafeInteger(offset) ? offset : null;
}

export function crashFrames(exceptionListJson) {
  const list = typeof exceptionListJson === "string" ? parse(exceptionListJson) : exceptionListJson;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => (Array.isArray(entry?.stacktrace?.frames) ? entry.stacktrace.frames : []));
}

export function freezeFrames(framesJson) {
  const list = typeof framesJson === "string" ? parse(framesJson) : framesJson;
  return Array.isArray(list) ? list : [];
}

export function nativeFrames(frames, images) {
  const out = [];
  for (const frame of frames) {
    const image = typeof frame?.module === "string" ? frame.module : "";
    const uuid = images.get(image);
    const offset = frameOffset(frame);
    if (uuid && offset != null) out.push({ image, uuid, offset });
  }
  return out;
}

export const frameKey = (uuid, offset) => `${uuid}+${offset}`;

export function wantedFrames(rows) {
  const wanted = new Map();
  for (const row of rows) {
    const images = imageUuids(row.images);
    const frames = row.kind === "freeze" ? freezeFrames(row.frames) : crashFrames(row.frames);
    for (const frame of nativeFrames(frames, images)) wanted.set(frameKey(frame.uuid, frame.offset), frame);
  }
  return [...wanted.values()];
}
