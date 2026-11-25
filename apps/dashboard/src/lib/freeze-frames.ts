import { imageUuids, nativeFrame, type NativeFrame } from "./native-frames.ts";

const OWN_IMAGE = /^(Ardia|Chromium Framework|hermes)/;

export function topOwnFrames(framesJson: string, imagesJson = "", limit = 3): NativeFrame[] {
  try {
    const frames = JSON.parse(framesJson) as { function?: unknown; module?: unknown; image_offset?: unknown }[];
    if (!Array.isArray(frames)) return [];
    const images = imageUuids(imagesJson);
    return frames
      .slice()
      .reverse()
      .map((f) => nativeFrame(f, images))
      .filter((f) => OWN_IMAGE.test(f.image || f.raw))
      .slice(0, limit);
  } catch {
    return [];
  }
}
