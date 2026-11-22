import type { EventSubscription } from "expo-modules-core";
import type { BangListReply } from "./documents";

export type AppEvent =
  | { type: "reopen"; pastFloating: boolean }
  | { type: "pipActivationReturn"; success: boolean; epoch: string }
  | { type: "pipActivationHandBack"; again: boolean; epoch: string }
  | { type: "willQuit" }
  | { type: "quitCancelled" }
  | { type: "appearance"; dark: boolean }
  | { type: "quitWarningSuppressed" }
  | { type: "resignActive" }
  | { type: "screenLocked" }
  | { type: "lockedOrAsleep" }
  | { type: "switcherReleased"; afterMenu?: boolean }
  | { type: "switcherKey"; key: "escape" | "next" | "previous" | "close" }
  | { type: "switcherMouseUp" }
  | { type: "dragEscape" }
  | { type: "unclaimedEscape"; windowId: string }
  | { type: "snapKeyHandedBack"; windowId: string; afterMenu?: boolean }
  | { type: "centeredResize"; epoch: string }
  | { type: "appLinkOpened"; windowId: string | null }
  | { type: "littleArdiaReturnedToApp" }
  | { type: "littleArdiaReturnDropped"; count: number }
  | { type: "littleArdiaLinkKeptBehind"; when: "activation" | "arrival" | "open" | "released" | "stageManager" | "keyRestored" | "windowManager" }
  | { type: "windowTitleRead"; epoch: string }
  | { type: "keyHoldReplay"; tag: number; count: number }
  | { type: "littleArdiaGlobalShortcut" }
  | { type: "littleArdiaGlobalShortcutBehind" }
  | { type: "windowDragLoop"; epoch: string }
  | {
      type: "pasteRefused";
      reason: string;
      epoch: string;
      gateOpen: boolean;
      layout?: string;
      types?: string[];
      responder?: string;
      dropped?: number;
    };

export type AppearanceMode = "auto" | "light" | "dark";

export type OpenURLSource = { bundleId: string | null; appName: string | null };

type ShellEvents = {
  onAppEvent: (e: AppEvent) => void;
  onOpenURLs: (e: { urls: string[]; pointer?: [number, number]; source?: OpenURLSource; returnTo?: string }) => void;
};

export type ShellNative = {
  addListener<K extends keyof ShellEvents>(name: K, listener: ShellEvents[K]): EventSubscription;
  setAppearance(mode: AppearanceMode): Promise<void>;
  isDarkAppearance(): Promise<boolean>;
  startDictation(): void;
  dictationAvailable?(): boolean;
  fetchBangList(etag: string | null): Promise<BangListReply>;
  copyText(text: string): void;
  readText(): Promise<string>;
};
