import type { EventSubscription } from "expo-modules-core";

export type ControlSocketStatus = { state: "on" | "off"; generation: number; path: string; reason?: string };
export type ControlRequest = { connection: number; generation: number; line: string };
export type ControlPeerAsk = { ask: number; name: string; signedBy: string; path: string; identifier: string; remember: boolean; deadline: number };
export type ControlPeerOutcome = "once" | "halfHour" | "always" | "deny" | "unshown" | "timeout" | "left" | "stopped" | "full" | "quiet" | "unsaved";
export type ControlPeerAnswer = Extract<ControlPeerOutcome, "once" | "halfHour" | "always" | "deny" | "unshown">;
export type ControlApproval = { key: string; name: string; signedBy: string; path?: string; added: number; until?: number };
export type ControlApprovals = { approvals: ControlApproval[]; problem?: string; doorbell?: boolean };

export type AutomationNative = {
  start(): Promise<ControlSocketStatus>;
  stop(): Promise<void>;
  reply(connection: number, line: string, ticket: number): void;
  broadcast(connections: number[], line: string): void;
  addListener(name: "onRequest", listener: (e: ControlRequest) => void): EventSubscription;
  addListener(name: "onClose", listener: (e: { connection: number }) => void): EventSubscription;
  addListener(name: "onWritten", listener: (e: { tickets: number[] }) => void): EventSubscription;
  addListener(name: "onPeerAsk", listener: (e: ControlPeerAsk) => void): EventSubscription;
  addListener(name: "onPeerAskEnded", listener: (e: { ask: number; outcome: ControlPeerOutcome }) => void): EventSubscription;
  answerPeer?(ask: number, outcome: ControlPeerAnswer): Promise<boolean>;
  approvals?(): Promise<ControlApprovals>;
  revokeApproval?(key: string): Promise<boolean>;
  devtoolsEndpoint?(connection: number): Promise<NativeDevtoolsEndpoint>;
  cutOff?(): boolean;
};

export const DEVTOOLS_ENDPOINT_PROBLEMS = ["off", "unreadable", "left"] as const;
export type DevtoolsEndpointProblem = (typeof DEVTOOLS_ENDPOINT_PROBLEMS)[number];
export type NativeDevtoolsEndpoint = { port: number; generation: number; token: string } | { problem: DevtoolsEndpointProblem };
