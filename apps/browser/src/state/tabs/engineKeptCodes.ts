import type { SleepVeto } from "./sleepPolicy";
import type { KeptAwakeReason } from "./sleepRefusals";

export type EngineKept = { code: number; veto: SleepVeto; menu: KeptAwakeReason; userMayOverride: boolean };

export const ENGINE_KEPT_CODES: readonly EngineKept[] = [
  { code: 100, veto: "postedDocument", menu: "postedDocument", userMayOverride: true },
  { code: 101, veto: "beforeUnload", menu: "beforeUnload", userMayOverride: true },
  { code: 102, veto: "download", menu: "download", userMayOverride: true },
  { code: 103, veto: "cliSession", menu: "other", userMayOverride: true },
];
