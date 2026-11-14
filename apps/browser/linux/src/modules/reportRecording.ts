import { BrowserWindow } from "electron";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emit } from "../bridge";
import { count } from "../counts";
import { note } from "../log";
import { dataDirectory, isBackground } from "../paths";
import { appWindow, host } from "../windows";
import { showRecordingPill, type RecordingPill } from "./recordingPill";

const DEFAULT_FPS = 30;
const TICK_MS = 1000;
const PULL_MS = 1000;
const MASK_MS = 200;
const START_DEADLINE_MS = 8000;
const RECORDER_PARTITION = "ardia-report-recorder";

type Recording = {
  recorder: BrowserWindow;
  path: string;
  thumbnail: string;
  includePages: boolean;
  startedAt: number;
  fps: number;
  width: number;
  height: number;
  ticker: ReturnType<typeof setInterval>;
  puller: ReturnType<typeof setInterval>;
  masker: ReturnType<typeof setInterval> | null;
  pill: RecordingPill | null;
  limit: ReturnType<typeof setTimeout> | null;
  pulling: Promise<void>;
};

let current: Recording | null = null;

type Masks = { width: number; height: number; rects: { x: number; y: number; width: number; height: number }[] };

const NO_MASKS: Masks = { width: 0, height: 0, rects: [] };

const recorderScript = (sourceId: string, fps: number, maxWidth: number, initial: Masks) => `(async () => {
  const source = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: ${JSON.stringify(sourceId)}, maxFrameRate: ${fps}${maxWidth > 0 ? `, maxWidth: ${maxWidth}` : ""} } } });
  const track = source.getVideoTracks()[0];
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = source;
  await video.play();
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  let masks = ${JSON.stringify(initial)};
  const draw = () => {
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    context.drawImage(video, 0, 0);
    if (masks.width > 0) {
      const sx = canvas.width / masks.width;
      const sy = canvas.height / masks.height;
      context.fillStyle = "#000";
      for (const rect of masks.rects) context.fillRect(Math.floor(rect.x * sx), Math.floor(rect.y * sy), Math.ceil(rect.width * sx) + 1, Math.ceil(rect.height * sy) + 1);
    }
  };
  window.ardiaMask = (next) => { masks = next || { width: 0, height: 0, rects: [] }; };
  const stream = canvas.captureStream(${fps});
  const painter = setInterval(draw, ${Math.round(1000 / 30)});
  const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2500000 });
  const pending = [];
  let thumbnail = null;
  recorder.ondataavailable = (event) => { if (event.data.size) pending.push(event.data); };
  window.ardiaRecorder = {
    take: async () => {
      const parts = pending.splice(0);
      const chunks = [];
      for (const part of parts) {
        const bytes = new Uint8Array(await part.arrayBuffer());
        let text = "";
        for (let at = 0; at < bytes.length; at += 32768) text += String.fromCharCode.apply(null, bytes.subarray(at, at + 32768));
        chunks.push(btoa(text));
      }
      return { chunks, thumbnail: thumbnail ? thumbnail.split(",")[1] : null };
    },
    stop: () => new Promise((resolve) => { recorder.onstop = () => { clearInterval(painter); track.stop(); resolve(true); }; recorder.stop(); }),
  };
  await new Promise((resolve) => setTimeout(resolve, 150));
  draw();
  thumbnail = canvas.toDataURL("image/png");
  recorder.start(${PULL_MS});
  return { width: canvas.width, height: canvas.height, type };
})()`;

async function pull(recording: Recording): Promise<void> {
  if (recording.recorder.isDestroyed()) return;
  const taken = (await recording.recorder.webContents.executeJavaScript("window.ardiaRecorder ? window.ardiaRecorder.take() : null", false).catch(() => null)) as { chunks: string[]; thumbnail: string | null } | null;
  if (!taken) return;
  for (const chunk of taken.chunks) appendFileSync(recording.path, Buffer.from(chunk, "base64"));
  if (taken.thumbnail && !existsSync(recording.thumbnail)) writeFileSync(recording.thumbnail, Buffer.from(taken.thumbnail, "base64"));
}

const queuePull = (recording: Recording) => (recording.pulling = recording.pulling.then(() => pull(recording)).catch(() => {}));

function clear(recording: Recording) {
  recording.pill?.close();
  if (recording.masker) clearInterval(recording.masker);
  clearInterval(recording.ticker);
  clearInterval(recording.puller);
  if (recording.limit) clearTimeout(recording.limit);
  if (!recording.recorder.isDestroyed()) recording.recorder.destroy();
  if (current === recording) current = null;
}

export const isRecording = (): boolean => current !== null;

export async function startRecording(windowId: string, includePages: boolean, path: string, maxSeconds: number | null, fps?: number | null, maxPixelWidth?: number | null): Promise<boolean> {
  if (current) return false;
  const window = appWindow(windowId);
  if (!window || window.isDestroyed() || !window.isVisible()) return false;
  const rate = fps && fps > 0 ? Math.min(fps, 60) : DEFAULT_FPS;
  rmSync(path, { force: true });
  const recorder = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { partition: RECORDER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  recorder.webContents.session.setPermissionRequestHandler((_contents, permission, answer) => answer(permission === "display-capture" || permission === "media"));
  const masksNow = async () => {
    const shell = host();
    if (includePages || !shell || shell.isDestroyed()) return null;
    return shell.webContents.executeJavaScript(`globalThis.ardiaLinuxPageRects ? globalThis.ardiaLinuxPageRects(${JSON.stringify(windowId)}) : null`, false).catch(() => null);
  };
  const sendMasks = async () => {
    const masks = await masksNow();
    if (masks && !recorder.isDestroyed()) await recorder.webContents.executeJavaScript(`window.ardiaMask && window.ardiaMask(${JSON.stringify(masks)})`, false).catch(() => {});
  };
  try {
    const page = join(dataDirectory(), "Reports", "recorder.html");
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(page, "<!doctype html><title>recorder</title>");
    await recorder.loadFile(page);
    const first = includePages ? NO_MASKS : ((await masksNow()) as Masks | null);
    if (!first) throw new Error("the window's pages couldn't be kept out");
    const started = (await Promise.race([
      recorder.webContents.executeJavaScript(recorderScript(window.getMediaSourceId(), rate, maxPixelWidth ?? 0, first), true),
      new Promise((resolve) => setTimeout(() => resolve(null), START_DEADLINE_MS)),
    ])) as { width: number; height: number; type: string } | null;
    if (!started) throw new Error("the window capture didn't start in time");
    await sendMasks();
    const recording: Recording = {
      recorder,
      path,
      thumbnail: `${path}.thumbnail.png`,
      includePages,
      startedAt: Date.now(),
      fps: rate,
      width: started.width,
      height: started.height,
      ticker: setInterval(() => {
        const seconds = Math.floor((Date.now() - recording.startedAt) / 1000);
        recording.pill?.setSeconds(seconds);
        emit("ArdiaReport", "onReport", { type: "tick", seconds });
      }, TICK_MS),
      puller: setInterval(() => queuePull(recording), PULL_MS),
      masker: includePages ? null : setInterval(() => void sendMasks(), MASK_MS),
      limit: maxSeconds && maxSeconds > 0 ? setTimeout(() => void stopRecording(), maxSeconds * 1000) : null,
      pulling: Promise.resolve(),
      pill: null,
    };
    recording.pill = isBackground() ? null : showRecordingPill(window, () => void stopRecording());
    rmSync(recording.thumbnail, { force: true });
    current = recording;
    count("report_recordings_started");
    note("report", `recording ${windowId} at ${started.width}x${started.height}, ${rate} fps, ${started.type}`);
    return true;
  } catch (error) {
    note("report", `couldn't record ${windowId}: ${error instanceof Error ? error.message : String(error)}`);
    count("report_recording_failures");
    if (!recorder.isDestroyed()) recorder.destroy();
    return false;
  }
}

export async function stopRecording(): Promise<boolean> {
  const recording = current;
  if (!recording) return false;
  current = null;
  recording.pill?.close();
  recording.pill = null;
  clearInterval(recording.ticker);
  clearInterval(recording.puller);
  if (recording.masker) clearInterval(recording.masker);
  if (recording.limit) clearTimeout(recording.limit);
  await recording.recorder.webContents.executeJavaScript("window.ardiaRecorder ? window.ardiaRecorder.stop() : false", true).catch(() => false);
  await queuePull(recording);
  clear(recording);
  const seconds = Math.max(0, (Date.now() - recording.startedAt) / 1000);
  const bytes = existsSync(recording.path) ? statSync(recording.path).size : 0;
  const result = bytes
    ? { path: recording.path, seconds, frames: Math.round(seconds * recording.fps), skipped: 0, fps: recording.fps, width: recording.width, height: recording.height, bytes, includePages: recording.includePages, windows: [], withheldWindows: 0 }
    : null;
  if (!result) count("report_recording_failures");
  emit("ArdiaReport", "onReport", { type: "stopped", result });
  return !!result;
}

export async function cancelRecording(): Promise<void> {
  const recording = current;
  if (!recording) return;
  clear(recording);
  rmSync(recording.path, { force: true });
  rmSync(recording.thumbnail, { force: true });
}

export async function recordingThumbnail(path: string, out: string): Promise<boolean> {
  const made = `${path}.thumbnail.png`;
  if (!existsSync(made)) return false;
  copyFileSync(made, out);
  return true;
}
