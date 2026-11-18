import type { KeptFollows } from "@ardia/shell";

export type FollowKeyboard = (tabId: string, windowId: string) => void;

export const followKeyboard: FollowKeyboard | null = null;

export const takeKeptFollows = (): KeptFollows => ({ kept: 0, used: 0, dropped: 0 });
