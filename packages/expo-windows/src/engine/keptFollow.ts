import type { KeptFollows } from "@ardia/shell";
import { fieldKeepsKeyboardFrom, focusedFieldInAnotherTab, onFieldAsked } from "../appKeyboard";

const NONE: KeptFollows = { kept: 0, used: 0, dropped: 0 };

let keptFor = "";
let counts: KeptFollows = { ...NONE };
let watchingFields = false;

export function keepFollow(key: string) {
  if (keptFor === key) return;
  dropKeptFollow();
  keptFor = key;
  counts.kept += 1;
  if (watchingFields) return;
  watchingFields = true;
  onFieldAsked(() => {
    if (!focusedFieldInAnotherTab(keptFor)) dropKeptFollow();
  });
}

export function dropKeptFollow() {
  if (!keptFor) return;
  keptFor = "";
  counts.dropped += 1;
}

export function spendKeptFollow(key: string, windowId: string): boolean {
  if (!keptFor || keptFor !== key) return false;
  if (fieldKeepsKeyboardFrom(windowId, key)) return (dropKeptFollow(), false);
  keptFor = "";
  counts.used += 1;
  return true;
}

export function takeKeptFollows(): KeptFollows {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
