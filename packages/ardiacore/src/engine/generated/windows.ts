import type { ChromeWindowState } from "../../windows";

export type WindowsCalls = {
  "windows.list": [{}, ChromeWindowState[]];
  "windows.dev": [{ window: number; action: string }, string];
};

export type WindowsEvents = {};
