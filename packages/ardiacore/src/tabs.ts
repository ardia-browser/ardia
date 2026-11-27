import type { TabGroupColor } from "@ardia/core";
import type { OpenWindowRequest } from "./pageTypes";
import { call } from "./engine/call";

export type StripTab = {
  key: string | null;
  browser: number;
  index: number;
  active: boolean;
  pinned: boolean;
  group?: string | null;
};

export type StripGroup = {
  id: string;
  title: string;
  color: TabGroupColor;
  collapsed: boolean;
};

export type StripState = {
  strip: number;
  window: number;
  appWindow?: string;
  profile: string;
  tabs: StripTab[];
  activePickedOnClose?: boolean;
  groups?: StripGroup[];
  closed?: boolean;
};

export type TabStripTransaction = {
  rev: number;
  cmd: number | null;
  strips: StripState[];
  rejected?: boolean;
};

export type TabStripCommand =
  | { op: "activate"; strip: number; key: string }
  | { op: "arrange"; strip: number; keys: string[]; pinned: number }
  | {
      op: "group";
      strip: number;
      keys: string[];
      group: string | null;
      title?: string;
      color?: StripGroup["color"];
      collapsed?: boolean;
    };

let lastCommand = Math.floor(Math.random() * 1e6) * 1e3;

export function sendTabStripCommand(command: TabStripCommand, refused?: (id: number, error: unknown) => void): number {
  const id = ++lastCommand;
  call("tabs.stripCommand", { id, command }).catch((error: unknown) => refused?.(id, error));
  return id;
}

export type LinkRoute = { profile?: string; adoptIds?: (string | null)[]; dismissed?: number[] };

export type WindowRequest = { request: OpenWindowRequest; profile: string; fromWindow?: string };

export type TabConsoleLevel = "debug" | "info" | "warning" | "error";

export type TabConsoleEntry = { seq: number; time: number; level: TabConsoleLevel; message: string; source: string; line: number; frame: "main" | "sub"; clipped?: boolean };

export type TabNetworkEntry = { seq: number; time: number; method: string; url: string; status: number; type: string; frame: "main" | "sub"; durationMs?: number; error?: string; failed?: boolean; cached?: boolean };

export type TabEngineRefusal = { ok: false; code: string; reason: string };

export type TabDiagnosticsRead = { ok: true; console: TabConsoleEntry[]; network: TabNetworkEntry[]; nextSeq: number; clearedBefore: number; capacity: { console: number; network: number } };

export type TabInputAction = "click" | "dblclick" | "move" | "down" | "up" | "wheel" | "key" | "text";

export type TabInputModifier = "shift" | "control" | "alt" | "meta";

export type TabInputArgs = { tabId: string; action: TabInputAction; x?: number; y?: number; button?: "left" | "middle"; clickCount?: number; modifiers?: TabInputModifier[]; deltaX?: number; deltaY?: number; key?: string; code?: string; text?: string; prime?: boolean; token?: number };

export type TabInputPrimed = { ok: true; painted: boolean; token?: number };

export type TabInputDone = { ok: true; acked: boolean; sent?: boolean; viewport: { width: number; height: number } };
