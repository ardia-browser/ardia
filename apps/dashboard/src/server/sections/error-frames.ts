import { frameLabel, imageUuids, nativeFrame, type FrameNames, type NativeFrame } from "../../lib/native-frames.ts";

type Frame = { function?: string; filename?: string; module?: string; lineno?: number | null; colno?: number | null; image_offset?: string };
export type ShownFrame = { fn: string; where: string; native: NativeFrame | null };

const POSTED_TASK = "PostedTask";
const MAX_CRASH_FRAMES = 40;
const MAX_POSTED_FRAMES = 17;
export const POSTED_TASK_LABEL = "Task posted from:";

type Entry = { type?: string; stacktrace?: { frames?: Frame[] } };

const innermostFirst = (entries: Entry[], max: number) =>
  entries
    .flatMap((entry) => entry.stacktrace?.frames ?? [])
    .reverse()
    .slice(0, max);

export function framesOf(list: string, imagesJson = ""): ShownFrame[] {
  try {
    const parsed = JSON.parse(list) as Entry[];
    const images = imageUuids(imagesJson);
    const shown = (frame: Frame): ShownFrame => {
      const file = frame.filename || frame.module || "";
      const line = frame.lineno ? `:${frame.lineno}${frame.colno ? `:${frame.colno}` : ""}` : "";
      const fn = frame.function && frame.function !== "?" ? frame.function : "anonymous";
      const native = frame.image_offset ? nativeFrame(frame, images) : null;
      return { fn, where: file ? `${file}${line}` : "", native: native?.uuid ? native : null };
    };
    const crash = innermostFirst(parsed.filter((entry) => entry.type !== POSTED_TASK), MAX_CRASH_FRAMES).map(shown);
    const posted = innermostFirst(parsed.filter((entry) => entry.type === POSTED_TASK), MAX_POSTED_FRAMES).map(shown);
    return posted.length ? [...crash, { fn: POSTED_TASK_LABEL, where: "", native: null }, ...posted] : crash;
  } catch {
    return [];
  }
}

export function frameLines(frames: ShownFrame[], names: FrameNames): string[] {
  return frames.map((f) => {
    const fn = f.native ? frameLabel(f.native, names) : f.fn;
    return f.where ? `${fn}  ${f.where}` : fn;
  });
}
