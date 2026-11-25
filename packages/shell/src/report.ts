import { requireNativeViewManager, type EventSubscription } from "expo-modules-core";
import type { ViewProps } from "react-native";
import type { ReportNative } from "./generated/native";

export type RecordingResult = {
  path: string;
  seconds: number;
  frames: number;
  skipped: number;
  fps: number;
  width: number;
  height: number;
  bytes: number;
  includePages: boolean;
  renderMsMean: number;
  renderMsP95: number;
  cpuPercent: number;
  footprintStartMB: number;
  footprintPeakMB: number;
  windows?: { kind: "pictureInPicture" | "chrome" | "app"; frames: number }[];
  withheldWindows?: number;
  maskedPages?: number;
  windowPictureMisses?: number;
  webKitMediaWithheld?: number;
};

export type UploadReply = { status: number; body: string; error?: string | null };

export type ReportEvent =
  | { type: "tick"; seconds: number }
  | { type: "stopped"; result: RecordingResult | null }
  | { type: "upload"; id: string; sent: number; total: number };

export type { ReportNative };

type ReportVideoProps = ViewProps & { path: string | null; playing: boolean };

export const ReportVideo = requireNativeViewManager<ReportVideoProps>("ArdiaReport");
