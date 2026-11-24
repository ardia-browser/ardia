import type { CastDialog, CastRoute, DeviceChooser } from "../../media";
import type { DisplayMediaSource } from "../../pageTypes";
import type { Profile } from "../wire";

export type MediaCalls = {
  "media.displayMediaSources": [{}, DisplayMediaSource[]];
  "media.displayMediaThumbnails": [{ ids: string[]; width: number }, Record<string, string>];
  "media.screenRecordingAllowed": [{}, boolean];
  "media.requestScreenRecording": [{}, boolean];
  "media.selectDevice": [{ id: number; index: number }, null];
  "media.cancelDeviceChooser": [{ id: number }, null];
  "media.refreshDeviceChooser": [{ id: number }, null];
  "media.openBluetoothSettings": [{ id: number }, null];
  "media.devShowBluetoothChooser": [{ tabId: string; unauthorized: boolean }, boolean];
  "media.devChooserEvents": [{}, Record<string, unknown>[]];
  "media.showCastDialog": [{ tabId: string }, boolean];
  "media.startCasting": [{ id: number; sink: string; mode: number }, null];
  "media.stopCasting": [{ id: number; route: string }, null];
  "media.closeCastDialog": [{ id: number }, null];
  "media.watchCastRoutes": [Profile, null];
  "media.terminateCastRoute": [{ route: string }, null];
  "media.changeCaptureSource": [{ capturer: string; target: string }, boolean];
  "media.stopCapture": [{ tabId: string }, boolean];
};

export type MediaEvents = {
  "media.deviceChooser": DeviceChooser;
  "media.castDialog": CastDialog;
  "media.castRoutes": { profile: string; routes: CastRoute[] };
};
