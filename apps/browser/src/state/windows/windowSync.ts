import type { LightsPlace, OpenWindowOptions, WindowEvent } from "../../platform/windows";
import type { BrowserState } from "../browser/store";
import { engineProfile, engineProfileForSpace, windowTitle } from "../browser/model";
import { windowOpens } from "./windowOpenOrder";
import { focusedWindowOf } from "./ui";
import { adoptOf } from "../tabs/pageSession";
import { noteLittleArdiaFitBelowSaved } from "../telemetry/littleArdiaEscapes";
import { isSmallWindow } from "./small";
import type { Frame } from "../browser/types";

const fitsBelowSaved = (frame: Frame, was: Frame | null | undefined, [width, height]: readonly [number, number]) =>
  (!was || was[2] !== frame[2] || was[3] !== frame[3]) && (Math.round(frame[2]) < width || Math.round(frame[3]) < height);

export type LightsCenter = LightsPlace | null;

export type WindowPort = {
  open(id: string, options: OpenWindowOptions, lightsCenter: LightsCenter): void;
  close(id: string): void;
  setTitle(id: string, title: string): void;
  windowIds(): Promise<string[]>;
  restoreFullScreen(ids: string[], focus: string | null): void;
  onEvent(listener: (e: WindowEvent) => void): void;
  releaseProfile(profile: string): void;
};

export type WindowSyncSetup = {
  port: WindowPort;
  getState(): BrowserState;
  isQuitting(): boolean;
  lightsCenter(s: BrowserState, id: string): LightsCenter;
  isUtilityWindow(id: string): boolean;
};

export function createWindowSync({ port, getState, isQuitting, lightsCenter, isUtilityWindow }: WindowSyncSetup) {
  const open = new Set<string>();
  const titles = new Map<string, string>();

  const privateProfiles = new Map<string, string>();

  const releasePrivateProfile = (id: string) => {
    const profile = privateProfiles.get(id);
    if (profile === undefined) return;
    privateProfiles.delete(id);
    port.releaseProfile(profile);
  };

  const listen = () =>
    port.onEvent((e) => {
      const s = getState();
      if (e.type === "focus") s.setFocusedWindow(e.id);
      if (e.type === "frame") {
        const w = s.windows[e.id];
        if (e.fitted && w && isSmallWindow(w) && fitsBelowSaved(e.frame, w.frame, s.settings.littleArdiaSize)) noteLittleArdiaFitBelowSaved();
        s.setWindowFrame(e.id, e.frame, e.restored, e.fitted);
      }
      if (e.type === "maximized" && !isQuitting()) s.setWindowMaximized(e.id, e.on);
      if (e.type === "fullScreen" && !isQuitting()) s.setWindowFullScreen(e.id, e.on, e.display);
      if (e.type === "close") {
        if (isQuitting()) return;
        open.delete(e.id);
        s.closeWindow(e.id);
        releasePrivateProfile(e.id);
      }
    });

  const sync = (s: BrowserState, prev?: BrowserState) => {
    const opens = windowOpens(s, s.windowOrder.filter((id) => !open.has(id)), !prev);
    for (const { id, focus, behind } of opens) {
      const w = s.windows[id]!;
      open.add(id);
      titles.set(id, windowTitle(s, id));
      const profile = engineProfile(s, w.spaceId);
      if (w.kind === "private") privateProfiles.set(id, profile);
      const claim = w.kind === "small" ? adoptOf(s.tabs[w.tabIds[0] ?? ""]) : undefined;
      const small = w.kind === "small"
        ? { kind: "small" as const, size: s.settings.littleArdiaSize, ...(claim?.startsWith("link:") ? { claim } : {}), ...(w.linkPointer ? { pointer: w.linkPointer } : {}), ...(w.linkApp ? { returnTo: w.linkApp } : {}) }
        : {};
      const made = w.kind !== "small" && w.chromeWindow ? { chromeWindow: w.chromeWindow } : {};
      const under = behind ?? (w.kind === "main" ? w.opensBehind : undefined);
      port.open(
        id,
        { frame: w.restoredFrame ?? w.frame, ...(w.maximized && w.kind !== "small" ? { maximized: true } : {}), incognito: w.kind === "private", title: titles.get(id), focus, profile, ...(w.display ? { display: w.display } : {}), ...(under ? { behind: under } : {}), ...(prev && w.kind !== "small" && !w.chromeWindow ? { animated: true } : {}), ...small, ...made },
        lightsCenter(s, id),
      );
    }
    for (const id of [...open]) {
      if (s.windows[id]) continue;
      open.delete(id);
      titles.delete(id);
      port.close(id);
      releasePrivateProfile(id);
    }
    if (prev && s.tabs === prev.tabs && s.windows === prev.windows && s.spaces === prev.spaces) return;
    for (const id of open) {
      const title = windowTitle(s, id);
      if (titles.get(id) !== title) {
        titles.set(id, title);
        port.setTitle(id, title);
      }
    }
  };

  const restoreFullScreen = (s: BrowserState) => {
    const stamp = (id: string) => s.windows[id]?.fullScreen ?? 0;
    const ids = s.windowOrder.filter((id) => stamp(id) > 0).sort((a, b) => stamp(a) - stamp(b));
    if (ids.length) port.restoreFullScreen(ids, focusedWindowOf(s));
  };

  const sweep = () =>
    port.windowIds().then((ids) => {
      const s = getState();
      for (const id of ids) {
        if (!s.windows[id]) {
          if (!isUtilityWindow(id)) port.close(id);
          continue;
        }
        const title = windowTitle(s, id);
        titles.set(id, title);
        port.setTitle(id, title);
      }
    });

  return { listen, sync, restoreFullScreen, sweep };
}
