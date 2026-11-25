import type { EventSubscription } from "expo-modules-core";
import type { ScriptingNative } from "./generated/native";

export type ScriptState = {
  windows: {
    id: string;
    title: string;
    profileId: string;
    incognito: boolean;
    activeTabId: string | null;
    tabs: { id: string; title: string; url: string; loading: boolean; pinned: boolean }[];
  }[];
  profiles: { id: string; name: string }[];
};

export type ScriptCommand = { id: string } & (
  | { command: "newWindow"; url?: string; incognito: boolean; profileId?: string }
  | { command: "newTab"; windowId?: string; url?: string; index?: number }
  | { command: "setURL"; tabId: string; url: string }
  | { command: "closeTab" | "reload" | "back" | "forward" | "focusTab"; tabId: string }
  | { command: "closeWindow"; windowId: string }
  | { command: "setActiveTabIndex"; windowId: string; index: number }
  | { command: "execute"; tabId: string; code: string }
  | { command: "focusProfile"; profileId: string }
  | { command: "reading" }
);

export type { ScriptingNative };
