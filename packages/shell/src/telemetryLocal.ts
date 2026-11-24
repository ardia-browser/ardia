import type { TelemetryLocalNative } from "./generated/native";

export type TelemetryLocalStats = { bytes: number; lines: number; files: number; droppedLines: number; pruneMs: number; writeMs: number[] };

export type TelemetryLocalExport = { path: string; bytes: number; lines: number };

export type { TelemetryLocalNative };
