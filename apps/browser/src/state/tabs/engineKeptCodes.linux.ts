import type { EngineKept } from "./engineKeptCodes";

export type { EngineKept };

export const ENGINE_KEPT_CODES: readonly EngineKept[] = [
  { code: 100, veto: "postedDocument", menu: "postedDocument", userMayOverride: true },
  { code: 101, veto: "beforeUnload", menu: "beforeUnload", userMayOverride: true },
  { code: 102, veto: "download", menu: "download", userMayOverride: true },
];
