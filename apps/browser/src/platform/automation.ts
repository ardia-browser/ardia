import { asSecret, type Secret } from "@ardia/core";
import { DEVTOOLS_ENDPOINT_PROBLEMS, nativeModule, type ControlApprovals, type FileArmClaim, type FileArmResult, type FileArmRow, type FileArmSpec, type PlacedDownload, type DevtoolsEndpointProblem, type ControlPeerAnswer, type ControlPeerAsk, type ControlPeerOutcome, type ControlRequest } from "@ardia/shell";

export type { FileArmClaim, FileArmKind, FileArmResult, FileArmRow, FileArmSpec, FileArmState, PlacedDownload } from "@ardia/shell";
export type { ControlApproval, ControlApprovals, ControlPeerAnswer, ControlPeerAsk, ControlPeerOutcome, ControlRequest, ControlSocketStatus } from "@ardia/shell";

let bound: ReturnType<typeof nativeModule<"ArdiaAutomation">> | null = null;
const Automation = () => (bound ??= nativeModule("ArdiaAutomation"));

export const startControlSocket = () => Automation().start();
export const stopControlSocket = () => Automation().stop();
export const cutOffControlSocket = () => Automation().cutOff?.() ?? false;
export const replyOnControlSocket = (connection: number, line: string, ticket = 0) => Automation().reply(connection, line, ticket);
export const broadcastOnControlSocket = (connections: number[], line: string) => Automation().broadcast(connections, line);
export const onControlRequest = (listener: (request: ControlRequest) => void) => Automation().addListener("onRequest", listener);
export const onControlClose = (listener: (e: { connection: number }) => void) => Automation().addListener("onClose", listener);
export const onControlWritten = (listener: (e: { tickets: number[] }) => void) => Automation().addListener("onWritten", listener);
export const onControlPeerAsk = (listener: (ask: ControlPeerAsk) => void) => Automation().addListener("onPeerAsk", listener);
export const onControlPeerAskEnded = (listener: (e: { ask: number; outcome: ControlPeerOutcome }) => void) => Automation().addListener("onPeerAskEnded", listener);
export const answerControlPeer = async (ask: number, outcome: ControlPeerAnswer) => (await Automation().answerPeer?.(ask, outcome)) ?? false;
export const controlApprovals = async (): Promise<ControlApprovals> => (await Automation().approvals?.()) ?? { approvals: [] };
export const revokeControlApproval = async (key: string) => (await Automation().revokeApproval?.(key)) ?? false;
export const armsFilePanels = () => typeof Automation().armFiles === "function";
export const armFilePanel = async (spec: FileArmSpec): Promise<FileArmResult> => (await Automation().armFiles?.(spec)) ?? { ok: false, reason: "unsupported" };
export const disarmFilePanels = (ids: string[] | null, purge: boolean): number => Automation().disarmFiles?.(ids, purge) ?? 0;
export const filePanelArms = async (): Promise<FileArmRow[]> => (await Automation().fileArms?.()) ?? [];
export const claimArmedDownload = (arm: string, download: string, path: string): FileArmClaim => Automation().claimArmedDownload?.(arm, download, path) ?? { ok: false, reason: "unsupported" };
export const releaseArmedDownload = (arm: string, download: string, state: string): boolean => Automation().releaseArmedDownload?.(arm, download, state) ?? false;
export const placeArmedDownload = async (arm: string, download: string, path: string): Promise<PlacedDownload> => (await Automation().placeArmedDownload?.(arm, download, path)) ?? { ok: false, reason: "unsupported" };

export type DevtoolsEndpoint = { port: number; generation: number; token: Secret<"devtoolsToken"> };
type DevtoolsEndpointRead = DevtoolsEndpoint | { problem: DevtoolsEndpointProblem | "unsupported" };

const knownProblem = (problem: unknown): DevtoolsEndpointProblem => (DEVTOOLS_ENDPOINT_PROBLEMS as readonly unknown[]).includes(problem) ? (problem as DevtoolsEndpointProblem) : "unreadable";

export async function controlDevtoolsEndpoint(connection: number): Promise<DevtoolsEndpointRead> {
  const read = Automation().devtoolsEndpoint;
  if (!read) return { problem: "unsupported" };
  const got = (await read(connection)) as Record<string, unknown> | null;
  if (got && typeof got.token === "string" && Number.isInteger(got.port) && Number.isInteger(got.generation)) {
    return { port: got.port as number, generation: got.generation as number, token: asSecret("devtoolsToken", got.token) };
  }
  return { problem: knownProblem(got?.problem) };
}
