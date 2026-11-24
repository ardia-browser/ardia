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
