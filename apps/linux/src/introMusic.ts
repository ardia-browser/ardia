import type { ArdiaHost } from "./host";
import { hostLaunchConfig } from "./hostLaunchConfig";
import { consentToken, type ConsentToken } from "../../browser/src/state/telemetry/consentPeriod.ts";

const MUTE_FADE_SECONDS = 0.25;
const FRAME_MS = 1000 / 60;

type Player = { volume: number; play(): Promise<void>; pause(): void; addEventListener(type: "ended", listener: () => void): void };
type FrameTimer = { every(tick: () => void, ms: number): unknown; cancel(handle: unknown): void };
type IntroMusicOptions = { host?: ArdiaHost; track?: () => Promise<string>; createPlayer?: (src: string) => Player; onPlayed?: (played: boolean, startedIn: ConsentToken | null) => void; frames?: FrameTimer };

const intervalFrames: FrameTimer = {
  every: (tick, ms) => setInterval(tick, ms),
  cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval> | undefined),
};

const bundledTrack = () => import("./introMusicTrack").then((module) => module.introMusicTrack);

const truthy = (value: string | undefined) => !!value && value !== "0" && value !== "off" && value !== "false";

export function introMusicSilenced(host?: ArdiaHost): boolean {
  const launch = hostLaunchConfig(host);
  return launch.background && !truthy(launch.instance.allowAudio);
}

export function linuxIntroMusic({ host, track = bundledTrack, createPlayer = (src) => new Audio(src), onPlayed, frames = intervalFrames }: IntroMusicOptions = {}) {
  let playing: Player | null = null;
  let loading: { muted: boolean } | null = null;
  let fading: unknown;

  const fade = (target: number, seconds: number, stopAfter: boolean) => {
    const audio = playing;
    if (!audio) return;
    frames.cancel(fading);
    const from = audio.volume;
    const steps = Math.max(1, Math.round(seconds * 60));
    let step = 0;
    const tick = () => {
      step++;
      audio.volume = Math.min(1, Math.max(0, from + (target - from) * (step / steps)));
      if (step < steps) return;
      frames.cancel(fading);
      if (!stopAfter) return;
      audio.pause();
      if (playing === audio) playing = null;
    };
    if (seconds <= 0) {
      step = steps - 1;
      tick();
      return;
    }
    fading = frames.every(tick, FRAME_MS);
  };

  return {
    playIntroMusic: async (_cues: unknown, muted: unknown) => {
      if (introMusicSilenced(host)) return;
      const startedIn = consentToken();
      const load = { muted: muted === true };
      loading = load;
      const src = await track().catch(() => null);
      if (loading !== load) return;
      loading = null;
      if (!src) return onPlayed?.(false, startedIn);
      frames.cancel(fading);
      playing?.pause();
      const audio = createPlayer(src);
      audio.volume = load.muted ? 0 : 1;
      audio.addEventListener("ended", () => {
        if (playing === audio) playing = null;
      });
      playing = audio;
      await audio.play().then(
        () => onPlayed?.(true, startedIn),
        (error: unknown) => {
          if (playing === audio) playing = null;
          onPlayed?.(false, startedIn);
          console.info(`[ardia linux] the intro music didn't play: ${String(error)}`);
        },
      );
    },
    setIntroMusicMuted: async (muted: unknown) => {
      if (loading) loading.muted = muted === true;
      fade(muted === true ? 0 : 1, MUTE_FADE_SECONDS, false);
    },
    stopIntroMusic: async (seconds: unknown) => {
      loading = null;
      fade(0, Math.max(0, Number(seconds) || 0), true);
    },
  };
}
