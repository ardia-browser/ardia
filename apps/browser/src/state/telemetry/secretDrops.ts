import { onSecretEscape } from "@ardia/core";
import { consentOrNow, countFor } from "./countFor";

let dropped = 0;
let watching: (() => void) | null = null;

export function watchSecretDrops() {
  watching ??= onSecretEscape(() => countFor(consentOrNow(undefined), () => void dropped++));
}

export function takeSecretValuesDropped() {
  const taken = dropped;
  dropped = 0;
  return taken;
}

export const takeSecretDropCounts = () => ({ secret_values_dropped: takeSecretValuesDropped() });
