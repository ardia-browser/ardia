import track from "../../../../../apps/browser/windows/Ardia/IntroMusic.wav?url";
import { callMainSync } from "../../bridge";

const MUTE_FADE_SECONDS = 0.25;
const FRAME_MS = 1000 / 60;

type LaunchFacts = { background?: boolean; instance?: Record<string, string> };

let playing: HTMLAudioElement | null = null;
let fading: ReturnType<typeof setInterval> | undefined;

const truthy = (value: string | undefined) => !!value && value !== "0" && value !== "off" && value !== "false";

function silenced(): boolean {
  const launch = callMainSync<LaunchFacts>("ArdiaApp", "launchConfig") ?? {};
  return !!launch.background && !truthy(launch.instance?.allowAudio);
}

function fade(target: number, seconds: number, stopAfter: boolean) {
  const audio = playing;
  if (!audio) return;
  clearInterval(fading);
  const from = audio.volume;
  const steps = Math.max(1, Math.round(seconds * 60));
  let step = 0;
  fading = setInterval(() => {
    step++;
    audio.volume = Math.min(1, Math.max(0, from + (target - from) * (step / steps)));
    if (step < steps) return;
    clearInterval(fading);
    if (!stopAfter) return;
    audio.pause();
    if (playing === audio) playing = null;
  }, FRAME_MS);
}

async function playIntroMusic(_cues: unknown, muted: boolean): Promise<void> {
  if (silenced()) return;
  playing?.pause();
  const audio = new Audio(track);
  audio.volume = muted ? 0 : 1;
  audio.addEventListener("ended", () => {
    if (playing === audio) playing = null;
  });
  playing = audio;
  await audio.play().catch((error: unknown) => console.info(`[ardia linux] the intro music didn't play: ${String(error)}`));
}

export const introMusicModules: Record<string, Record<string, unknown>> = {
  ArdiaApp: {
    playIntroMusic,
    setIntroMusicMuted: async (muted: boolean) => fade(muted ? 0 : 1, MUTE_FADE_SECONDS, false),
    stopIntroMusic: async (seconds: number) => fade(0, Math.max(0, Number(seconds) || 0), true),
  },
};
