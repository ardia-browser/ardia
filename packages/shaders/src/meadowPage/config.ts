import type { MeadowIntro } from "../index";

export const MEADOW_INK = {
  light: { ink: "#16130F", halo: [243, 236, 223] },
  dark: { ink: "#EFE8DC", halo: [18, 16, 26] },
} as const;

export const MEADOW_HANDOFF = { duration: 400, easing: "cubic-bezier(0.37,0,0.63,1)" } as const;

export type MeadowPageConfig = {
  intro: MeadowIntro;
  night: boolean;
  ink: typeof MEADOW_INK;
  muteIcons: { muted: string; playing: string };
  handoff: { duration: number; easing: string };
};

export type MeadowPageState =
  | { state: "ready"; at: number }
  | { state: "failed" }
  | { state: "tone"; tone: string; halo: number }
  | { state: "skip" }
  | { state: "mute"; muted: boolean };

export type MeadowPageReport = { states: MeadowPageState[]; frames: number; ms: number };

export const MEADOW_PAGE_CONFIG_ID = "ardia-intro";

export const MEADOW_PAGE_API = "ardiaIntro";
