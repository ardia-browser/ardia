import type { EventSubscription } from "expo-modules-core";
import type { AutomationNative } from "./generated/native";

export type ControlSocketStatus = { state: "on" | "off"; generation: number; path: string; reason?: string };
export type ControlRequest = { connection: number; generation: number; line: string };
export type ControlPeerAsk = { ask: number; name: string; signedBy: string; path: string; identifier: string; remember: boolean; deadline: number };
export type ControlPeerOutcome = "once" | "halfHour" | "always" | "deny" | "unshown" | "timeout" | "left" | "stopped" | "full" | "quiet" | "unsaved";
export type ControlPeerAnswer = Extract<ControlPeerOutcome, "once" | "halfHour" | "always" | "deny" | "unshown">;
export type ControlApproval = { key: string; name: string; signedBy: string; path?: string; added: number; until?: number };
export type ControlApprovals = { approvals: ControlApproval[]; problem?: string; doorbell?: boolean };

export type { AutomationNative };

export const DEVTOOLS_ENDPOINT_PROBLEMS = ["off", "unreadable", "stale", "left"] as const;
export type DevtoolsEndpointProblem = (typeof DEVTOOLS_ENDPOINT_PROBLEMS)[number];
export type NativeDevtoolsEndpoint = { port: number; generation: number; token: string } | { problem: DevtoolsEndpointProblem };

export type FileArmKind = "upload" | "download";
export type FileArmState = "armed" | "answered" | "claimed" | "failed" | "expired" | "cleared";
export type FileArmSpec = { id: string; kind: FileArmKind; tab: string | null; window: string | null; paths: string[]; once: boolean; seconds: number };
export type FileArmRow = { id: string; kind: FileArmKind; tab: string | null; paths: string[]; folder: boolean; once: boolean; armedAt: number; expiresAt: number; state: FileArmState; reason?: string; landed: string[]; answered: number };
export type FileArmResult = { ok: true; arm: FileArmRow } | { ok: false; reason: string; path?: string; arm?: string };
export type FileArmClaim = { ok: true; mode: "automatic" | "prompted" } | { ok: false; reason: string };
export type PlacedDownload = { ok: true; path: string; bytes: number; sourceLeft?: boolean; sourceLeftAt?: string } | { ok: false; reason: string; stagedPath?: string };
