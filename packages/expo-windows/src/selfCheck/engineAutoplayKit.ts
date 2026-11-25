import { engineAvailable, engineCallJson, hostCall, onEngineTopic } from "../engine/host";
import { httpPagesPort } from "./engineBackForward";
import { expectEqual } from "./check";
import { evaluate, firstWindow, heard, LEFT, listed, pause, show, until } from "./engineSleep";

export const SETTLE_MS = 6000;
export const LOAD_MS = 20000;
export const PLAY_BUTTON = { x: 100, y: 130 };
export const NEXT_LINK = { x: 100, y: 185 };
export const CTRL = 2;
export const AUTOPLAY_SETTLES_MS = 1500;
export const PER_PAGE_COUNT = 20;
export const TRANSIENT_ACTIVATION_MS = 6000;
export const TOUCH_POINT = { x: 80, y: 45 };

type Played = { paused?: boolean; ended?: boolean; ready?: number; time?: number; tries?: string[]; active?: boolean };

export const port = engineAvailable() ? httpPagesPort() : null;
export const origin = `http://127.0.0.1:${port}`;

export async function setSite(type: "autoplay" | "sound", value: "allow" | "block" | "default") {
  const reply = JSON.parse(await engineCallJson("ac_site_settings_set", "", JSON.stringify({ origin, type, value }))) as { error?: unknown };
  expectEqual(reply.error, undefined, `${type} set to ${value} for ${origin}`);
}

export const setAutoplay = (value: "allow" | "block" | "default") => setSite("autoplay", value);

export const mediaCommand = (key: string, action: string) => hostCall("tab.call", { key, method: "mediaCommand", action });
export const countsOf = (key: string) => {
  const counts: number[] = [];
  const watching = onEngineTopic("tab", (event: { key?: unknown; name?: unknown; data?: { count?: unknown } }) => {
    if (event.key === key && event.name === "autoplayBlocked") counts.push(Number(event.data?.count));
  });
  return { counts, total: () => counts.reduce((sum, count) => sum + count, 0), stop: () => watching.remove() };
};
export const blockEverywhere = (enabled: boolean) => hostCall<{ everywhere?: unknown }>("autoplay.everywhere", { enabled });

export async function withMedia(name: string, path: string, title: string, run: (key: string, windowId: string) => Promise<void>) {
  const key = `self-check-autoplay-${name}`;
  const windowId = await firstWindow();
  try {
    await hostCall("tab.create", { key, url: `${origin}/${path}`, profile: "" }, windowId);
    await show(key, windowId, LEFT);
    await until(`the page ${key} loads`, LOAD_MS, () => listed(key), (tab) => tab?.title === title && tab.loading === false);
    await run(key, windowId);
  } finally {
    await hostCall("tab.close", { key }).catch(() => null);
  }
}

const tried = async (key: string, media: string) =>
  evaluate(key, `const media = ${media}; window.lastMedia = media; media.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));`);
export const stateOf = async (key: string, media: string) =>
  ((await evaluate(key, `const media = ${media}; post("result", JSON.stringify(media ? { paused: media.paused, time: media.currentTime } : {}));`)) ?? {}) as Played;
export const DETACHED_MUTED_VIDEO = 'Object.assign(document.createElement("video"), { muted: true, loop: true, src: "/tone.wav" })';
export const DETACHED_SOUND = 'Object.assign(new Audio("/tone.wav"), { loop: true })';
export const loadedAt = (key: string, path: string, title: string) => until(`the page ${key} shows ${path}`, LOAD_MS, () => listed(key), (tab) => String(tab?.url).endsWith(path) && tab?.title === title && tab.loading === false);

export async function refusedThenStill(key: string, media: string, what: string) {
  expectEqual(await tried(key, media), "NotAllowedError", `${what}: play() is refused as on the Mac`);
  await pause(AUTOPLAY_SETTLES_MS / 2);
  expectEqual((await stateOf(key, "window.lastMedia")).paused, true, `${what}: it stays paused`);
}

export const played = async (key: string) => ((await evaluate(key, 'post("result", JSON.stringify({ paused: m.paused, ended: m.ended, ready: m.readyState, time: m.currentTime, tries }));')) ?? {}) as Played;
export const framed = async (key: string) => ((await evaluate(key, 'post("result", JSON.stringify(frameState || {}));')) ?? {}) as Played;
export const playing = (state: Played) => state.paused === false && (state.time ?? 0) > 0.3;
export const held = (state: Played) => state.paused === true && (state.tries?.length ?? 0) > 0;
export const blockedHeard = (key: string, what: string) => heard("tab", (event) => event.key === key && event.name === "autoplayBlocked" && Number(event.data?.count) > 0, what);

export async function restore() {
  await blockEverywhere(false).catch(() => null);
  for (const type of ["autoplay", "sound"]) await engineCallJson("ac_site_settings_set", "", JSON.stringify({ origin, type, value: "default" })).catch(() => null);
}

export const blocked = (run: () => Promise<void>) => async () => {
  try {
    await setAutoplay("block");
    await run();
  } finally {
    await restore();
  }
};

