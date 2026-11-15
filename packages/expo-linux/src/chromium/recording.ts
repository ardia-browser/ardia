import { callMain, callMainSync } from "../bridge";
import { addNativeListener, emitNativeEvent } from "../events";

const MODULE = "ArdiaReport";
const DEFAULT_FPS = 30;
const MOST_FPS = 60;
const TICK_MS = 1000;
const CHUNK_MS = 1000;
const MASK_MS = 200;
const PAINT_MS = Math.round(1000 / 30);
const START_DEADLINE_MS = 8000;
const FIRST_FRAME_MS = 150;
const BITS_PER_SECOND = 2_500_000;
const TYPES = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"];

type Rect = { x: number; y: number; width: number; height: number };
type Masks = { width: number; height: number; rects: Rect[] };

export type EngineRecordingResult = {
  path: string;
  seconds: number;
  frames: number;
  skipped: number;
  fps: number;
  width: number;
  height: number;
  bytes: number;
  includePages: boolean;
  windows: never[];
  withheldWindows: number;
};

type Recording = {
  windowId: string;
  path: string;
  includePages: boolean;
  fps: number;
  width: number;
  height: number;
  startedAt: number;
  stream: MediaStream;
  recorder: MediaRecorder;
  timers: ReturnType<typeof setInterval>[];
  limit: ReturnType<typeof setTimeout> | null;
  writes: Promise<unknown>;
  bytes: number;
  failed: boolean;
};

let current: Recording | null = null;
let pillListening = false;

const NO_MASKS: Masks = { width: 0, height: 0, rects: [] };

const pageRects = (windowId: string): Masks | null => (callMainSync<Masks | null>(MODULE, "recordingPageRects", windowId) as Masks | null | undefined) ?? null;

const note = (outcome: "started" | "failed" | "stopped") => void callMainSync(MODULE, "noteRecording", outcome);

function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 32768) text += String.fromCharCode(...bytes.subarray(at, at + 32768));
  return btoa(text);
}

function withDeadline<Value>(work: Promise<Value>, ms: number, what: string): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} didn't start in time`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function listenToPill() {
  if (pillListening) return;
  pillListening = true;
  addNativeListener(MODULE, "recordingPill", (payload) => {
    if ((payload as { action?: unknown } | null)?.action === "stop") void stopEngineRecording();
  });
}

function painter(video: HTMLVideoElement, canvas: HTMLCanvasElement, masks: () => Masks) {
  const context = canvas.getContext("2d");
  return () => {
    if (!context || !video.videoWidth) return;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    context.drawImage(video, 0, 0);
    const shape = masks();
    if (shape.width <= 0 || shape.height <= 0) return;
    const sx = canvas.width / shape.width;
    const sy = canvas.height / shape.height;
    context.fillStyle = "#000";
    for (const rect of shape.rects) context.fillRect(Math.floor(rect.x * sx), Math.floor(rect.y * sy), Math.ceil(rect.width * sx) + 1, Math.ceil(rect.height * sy) + 1);
  };
}

function thumbnailOf(canvas: HTMLCanvasElement): string | null {
  const url = canvas.toDataURL("image/png");
  const comma = url.indexOf(",");
  return comma < 0 ? null : url.slice(comma + 1);
}

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

function clear(recording: Recording) {
  for (const timer of recording.timers) clearInterval(timer);
  if (recording.limit) clearTimeout(recording.limit);
  stopTracks(recording.stream);
  callMainSync(MODULE, "hideRecordingPill");
  if (current === recording) current = null;
}

export const isEngineRecording = (): boolean => current !== null;

export async function startEngineRecording(windowId: string, includePages: boolean, path: string, maxSeconds: number | null, fps?: number | null, maxPixelWidth?: number | null): Promise<boolean> {
  if (current) return false;
  const rate = fps && fps > 0 ? Math.min(fps, MOST_FPS) : DEFAULT_FPS;
  let stream: MediaStream | null = null;
  try {
    const first = includePages ? NO_MASKS : pageRects(windowId);
    if (!first) throw new Error("the window's pages couldn't be kept out");
    const token = await callMain<string>(MODULE, "recordingSource", windowId);
    if (!token) throw new Error("the window can't be captured");
    const mandatory: Record<string, unknown> = { chromeMediaSource: "desktop", chromeMediaSourceId: token, maxFrameRate: rate };
    if (maxPixelWidth && maxPixelWidth > 0) mandatory.maxWidth = maxPixelWidth;
    stream = await withDeadline(navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory } as MediaTrackConstraints }), START_DEADLINE_MS, "the window capture");
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await withDeadline(video.play(), START_DEADLINE_MS, "the window's video");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    let masks = first;
    const paint = painter(video, canvas, () => masks);
    const type = TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!type) throw new Error("no video format can be recorded");
    await callMain(MODULE, "writeRecording", path, "");
    const recorder = new MediaRecorder(canvas.captureStream(rate), { mimeType: type, videoBitsPerSecond: BITS_PER_SECOND });
    const recording: Recording = {
      windowId,
      path,
      includePages,
      fps: rate,
      width: canvas.width,
      height: canvas.height,
      startedAt: Date.now(),
      stream,
      recorder,
      timers: [],
      limit: null,
      writes: Promise.resolve(),
      bytes: 0,
      failed: false,
    };
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      const part = event.data;
      recording.writes = recording.writes.then(async () => {
        const written = await callMain<number>(MODULE, "appendRecording", path, base64Of(new Uint8Array(await part.arrayBuffer()))).catch(() => null);
        if (typeof written === "number") recording.bytes = written;
        else recording.failed = true;
      });
    };
    recording.timers.push(setInterval(paint, PAINT_MS));
    if (!includePages) recording.timers.push(setInterval(() => (masks = pageRects(windowId) ?? masks), MASK_MS));
    await new Promise((resolve) => setTimeout(resolve, FIRST_FRAME_MS));
    paint();
    recording.width = canvas.width;
    recording.height = canvas.height;
    const thumbnail = thumbnailOf(canvas);
    if (thumbnail) await callMain(MODULE, "writeRecording", `${path}.thumbnail.png`, thumbnail).catch(() => null);
    recorder.start(CHUNK_MS);
    recording.startedAt = Date.now();
    recording.timers.push(
      setInterval(() => {
        const seconds = Math.floor((Date.now() - recording.startedAt) / 1000);
        callMainSync(MODULE, "setRecordingSeconds", seconds);
        emitNativeEvent(MODULE, "onReport", { type: "tick", seconds });
      }, TICK_MS),
    );
    if (maxSeconds && maxSeconds > 0) recording.limit = setTimeout(() => void stopEngineRecording(), maxSeconds * 1000);
    current = recording;
    listenToPill();
    callMainSync(MODULE, "showRecordingPill", windowId);
    note("started");
    return true;
  } catch (error) {
    console.warn(`[ardia linux] couldn't record ${windowId}: ${error instanceof Error ? error.message : String(error)}`);
    if (stream) stopTracks(stream);
    note("failed");
    return false;
  }
}

function finishRecorder(recorder: MediaRecorder): Promise<void> {
  if (recorder.state === "inactive") return Promise.resolve();
  return new Promise((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.stop();
  });
}

export async function stopEngineRecording(): Promise<boolean> {
  const recording = current;
  if (!recording) return false;
  current = null;
  callMainSync(MODULE, "hideRecordingPill");
  await finishRecorder(recording.recorder);
  await recording.writes;
  clear(recording);
  const seconds = Math.max(0, (Date.now() - recording.startedAt) / 1000);
  const result: EngineRecordingResult | null =
    recording.bytes > 0 && !recording.failed
      ? {
          path: recording.path,
          seconds,
          frames: Math.round(seconds * recording.fps),
          skipped: 0,
          fps: recording.fps,
          width: recording.width,
          height: recording.height,
          bytes: recording.bytes,
          includePages: recording.includePages,
          windows: [],
          withheldWindows: 0,
        }
      : null;
  note(result ? "stopped" : "failed");
  emitNativeEvent(MODULE, "onReport", { type: "stopped", result });
  return !!result;
}

export async function cancelEngineRecording(): Promise<void> {
  const recording = current;
  if (!recording) return;
  clear(recording);
  recording.recorder.ondataavailable = null;
  await finishRecorder(recording.recorder).catch(() => {});
  await recording.writes.catch(() => {});
  callMainSync(MODULE, "removeFile", recording.path);
  callMainSync(MODULE, "removeFile", `${recording.path}.thumbnail.png`);
}

