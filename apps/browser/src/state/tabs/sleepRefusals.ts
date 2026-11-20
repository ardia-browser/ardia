export type KeptAwakeReason = "playingOrSharing" | "audio" | "pictureInPicture" | "capturing" | "device" | "devTools" | "typedInput" | "noPage" | "other";

const OVERRIDDEN_BY_ASKING: ReadonlySet<number> = new Set([6, 7, 13, 14, 23, 25]);

const REASONS: Readonly<Record<number, KeptAwakeReason>> = {
  [-1]: "noPage",
  5: "audio",
  8: "pictureInPicture",
  15: "capturing",
  16: "capturing",
  17: "capturing",
  18: "capturing",
  19: "capturing",
  20: "device",
  21: "device",
  24: "devTools",
  26: "typedInput",
  27: "typedInput",
};

export const onlyAutomaticProtections = (keptBy: readonly number[]) => keptBy.length > 0 && keptBy.every((r) => OVERRIDDEN_BY_ASKING.has(r));

export function keptAwakeReason(keptBy: readonly number[]): KeptAwakeReason {
  for (const r of keptBy) if (!OVERRIDDEN_BY_ASKING.has(r)) return REASONS[r] ?? "other";
  return "other";
}
