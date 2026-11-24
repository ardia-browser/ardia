import { takeKeptFollows } from "../../platform/keyboardFollow";

export function takeKeyboardFollowCounts() {
  const { kept, used, dropped } = takeKeptFollows();
  return { keyboard_follows_kept: kept, keyboard_follows_used: used, keyboard_follows_dropped: dropped };
}
