import type { EngineKept } from "./engineKeptCodes";

export type { EngineKept };

export const ENGINE_KEPT_CODES: readonly EngineKept[] = [
  { code: 100, veto: "other", menu: "other", userMayOverride: false },
  { code: 101, veto: "beforeUnload", menu: "beforeUnload", userMayOverride: false },
  { code: 102, veto: "other", menu: "other", userMayOverride: false },
  { code: 103, veto: "other", menu: "other", userMayOverride: false },
  { code: 104, veto: "other", menu: "other", userMayOverride: false },
  { code: 105, veto: "other", menu: "other", userMayOverride: false },
];
