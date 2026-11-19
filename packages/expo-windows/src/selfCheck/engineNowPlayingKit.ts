import type { AppNative } from "@ardia/shell";
import { hostCall, onEngineTopic } from "../engine/host";
import { requireNativeModule } from "../modules";
import { expectEqual, expectTrue } from "./check";
import { SETTLE_MS, withMedia } from "./engineAutoplayKit";
import { evaluate, LEFT, show, until } from "./engineSleep";

export type NowPlaying = { title?: string; artist?: string; album?: string; artwork?: string | null; playbackState?: string; position?: number; duration?: number | null; playbackRate?: number; timestamp?: number; hasVideo?: boolean; actions?: string[]; controllable?: boolean; loop?: boolean };
export type PageState = { paused?: boolean; time?: number; ended?: boolean; calls?: string[]; ad?: { active?: boolean; tried?: string | null } | null; frame?: { paused?: boolean; time?: number; calls?: string[]; preview?: boolean | null } | null; burstDone?: boolean };
export type Image = { uri?: string | null; width?: number; height?: number };

export const TITLE = "now playing page";
export const FRAME_TITLE = "now playing frame";
export const SONG = { title: "Ardia Song", artist: "Ardia Band", album: "Ardia Album" };
export const ART_PIXELS = 256;
const PNG_DATA = "data:image/png;base64,";

export function reportsOf(key: string) {
  const reports: (NowPlaying | null)[] = [];
  const watching = onEngineTopic("tab", (event: { key?: unknown; name?: unknown; data?: { state?: NowPlaying | null } }) => {
    if (event.key === key && event.name === "nowPlaying") reports.push(event.data?.state ?? null);
  });
  return { reports, latest: async () => (reports.length ? reports[reports.length - 1]! : undefined), stop: () => watching.remove() };
}

export type Reports = ReturnType<typeof reportsOf>;

export const command = (key: string, action: string, seconds: number | null = null) => hostCall("tab.call", { key, method: "mediaCommand", action, seconds });

export const commandAnswer = (key: string, action: string, seconds: number | null = null) =>
  command(key, action, seconds).then(
    () => "done",
    () => "refused",
  );

export const pageState = async (key: string) =>
  ((await evaluate(
    key,
    'const media = typeof m === "undefined" ? null : m; post("result", JSON.stringify({ paused: media ? media.paused : null, time: media ? media.currentTime : null, ended: media ? media.ended : null, calls: window.calls || [], ad: window.adState || null, frame: window.frameState || null, burstDone: !!window.burstDone }));',
  )) ?? {}) as PageState;

export type MediaState = { time?: number; paused?: boolean; readyState?: number; networkState?: number; duration?: number | string; seekable?: number[][] };

export const mediaState = async (key: string) =>
  ((await evaluate(
    key,
    'const seekable = []; for (let i = 0; i < m.seekable.length; i++) seekable.push([m.seekable.start(i), m.seekable.end(i)]); post("result", JSON.stringify({ time: m.currentTime, paused: m.paused, readyState: m.readyState, networkState: m.networkState, duration: Number.isFinite(m.duration) ? m.duration : String(m.duration), seekable }));',
  )) ?? {}) as MediaState;

export const commandReply = (key: string, action: string, seconds: number | null = null) =>
  command(key, action, seconds).then(
    (reply) => JSON.stringify(reply),
    (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`,
  );

export const startPlaying = async (key: string) => {
  const started = await evaluate(key, 'm.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));', true);
  expectEqual(started, "played", "the page plays with sound under a script gesture");
};

export const unaskedPlay = (key: string) => evaluate(key, 'm.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));');

export const pausePage = (key: string) => evaluate(key, 'm.pause(); post("result", "true");');

export const reported = (reports: Reports, what: string, done: (state: NowPlaying | null | undefined) => boolean) => until(`${what} (nowPlaying)`, SETTLE_MS, reports.latest, done);
export const isPlaying = (state: NowPlaying | null | undefined) => state?.playbackState === "playing";
export const isPaused = (state: NowPlaying | null | undefined) => state?.playbackState === "paused";
export const called = (key: string, call: string, what: string) => until(what, SETTLE_MS, () => pageState(key), (state) => !!state.calls?.includes(call));
export const projected = (state: NowPlaying, now = Date.now()) => (state.position ?? 0) + (isPlaying(state) ? ((now - (state.timestamp ?? now)) / 1000) * (state.playbackRate || 1) : 0);

export async function withReports(name: string, path: string, title: string, run: (key: string, reports: Reports, windowId: string) => Promise<void>) {
  const reports = reportsOf(`self-check-autoplay-${name}`);
  try {
    await withMedia(name, path, title, (key, windowId) => run(key, reports, windowId));
  } finally {
    reports.stop();
  }
}

export const testPort = (name: string) => {
  const value = requireNativeModule<Pick<AppNative, "launchConfig">>("ArdiaApp").launchConfig().test?.[name];
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
};

export type ActiveSession = { any?: boolean; active?: boolean };

export const activeSessionOf = async (key: string) => ((await hostCall<ActiveSession>("tab.call", { key, method: "activeSessionForTest" })) ?? {}) as ActiveSession;

export async function downloaded(key: string, url: string): Promise<Image | null> {
  return (await hostCall<Image>("tab.call", { key, method: "downloadImage", url, maxPixels: ART_PIXELS })) ?? null;
}

export function expectPng(image: Image | null, what: string) {
  expectTrue(typeof image?.uri === "string" && image.uri.startsWith(PNG_DATA), `${what}: a PNG data URI, got ${JSON.stringify(image).slice(0, 120)}`);
  const width = image!.width ?? 0;
  const height = image!.height ?? 0;
  expectTrue(width > 0 && height > 0 && width <= ART_PIXELS && height <= ART_PIXELS, `${what}: within ${ART_PIXELS} px, got ${width}x${height}`);
}

export async function playFrame(key: string, windowId: string) {
  await show(key, windowId, LEFT);
  await until("the cross-site iframe reports", SETTLE_MS, () => pageState(key), (state) => state.frame?.paused === true);
  await evaluate(key, 'document.querySelector("iframe").contentWindow.postMessage("np-play", "*"); post("result", "true");', true);
  await until("the iframe plays its media when the page, which the user activated, asks it to (allow=autoplay)", SETTLE_MS, () => pageState(key), (state) => state.frame?.paused === false);
}
