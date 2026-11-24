import type { MediaAccess } from "../../platform/tabs";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { noteMediaCardCallToggle } from "../telemetry/mediaCardCounts";
import { hasTrackControls, mediaCommand, type Session } from "./media";

export const isLiveSession = (session: Pick<Session, "duration">) => session.duration === null;

export const hasCallActions = (session: Pick<Session, "actions">) =>
  session.actions.includes("togglemicrophone") ||
  session.actions.includes("togglecamera") ||
  session.actions.includes("hangup");

export const isCallSession = (
  session: Pick<Session, "duration" | "actions">,
  mediaAccess: MediaAccess | null | undefined,
) => hasCallActions(session) || (isLiveSession(session) && !!(mediaAccess && (mediaAccess.camera || mediaAccess.microphone || mediaAccess.screen)));

export type CallControl = {
  kind: "mic" | "camera";
  active: boolean;
  icon: string;
  tooltip: string;
  action: "toggleMicrophone" | "toggleCamera";
};

export type PlayerControlsModel =
  | { kind: "call"; controls: CallControl[] }
  | { kind: "playback"; canSkip: boolean; tracks: boolean };

export function playerControlsFor(
  session: Session,
  mediaAccess: MediaAccess | null | undefined,
  callControlsSupported = PLATFORM_FEATURES.callMediaControls,
): PlayerControlsModel {
  if (isCallSession(session, mediaAccess)) {
    const controls: CallControl[] = [];
    if (callControlsSupported && session.actions.includes("togglemicrophone")) {
      const active = session.microphoneActive ?? Boolean(mediaAccess?.microphone);
      controls.push({
        kind: "mic",
        active,
        icon: active ? "mic.fill" : "mic.slash.fill",
        tooltip: active ? "Mute Microphone" : "Unmute Microphone",
        action: "toggleMicrophone",
      });
    }
    if (callControlsSupported && session.actions.includes("togglecamera")) {
      const active = session.cameraActive ?? Boolean(mediaAccess?.camera);
      controls.push({
        kind: "camera",
        active,
        icon: active ? "video.fill" : "video.slash.fill",
        tooltip: active ? "Turn Off Camera" : "Turn On Camera",
        action: "toggleCamera",
      });
    }
    return { kind: "call", controls };
  }
  const tracks = hasTrackControls(session);
  const canSkip = tracks || !isLiveSession(session) || session.actions.includes("seekbackward") || session.actions.includes("seekforward");
  return { kind: "playback", canSkip, tracks };
}

export function toggleCallControl(tabId: string, kind: "mic" | "camera") {
  noteMediaCardCallToggle(kind);
  mediaCommand(tabId, kind === "mic" ? "toggleMicrophone" : "toggleCamera");
}
