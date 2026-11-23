import type { CredentialProviderState } from "./providerModel";
import { serversOf } from "./providerModel";
import { serverLabel } from "./servers";

export type StatusTone = "textSecondary" | "warning" | "destructive";

export type ManagerAction = "unlock" | "signIn" | "continue" | "restart" | "turnOn" | "check" | "none";

export type ManagerStatus = { line: string; tone: StatusTone; command: string | null; action: ManagerAction; menu: boolean };

const OUTDATED = new Set(["cliTooOld", "outdated", "cliOutdated"]);
const UNAVAILABLE_LINES = { crashed: "Quit unexpectedly", updating: "Updating…", damaged: "Damaged", off: "Off" } as const;

const joined = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

export function managerStatus(p: CredentialProviderState): ManagerStatus {
  const server = serverLabel(serversOf(p), p.server);
  const problem = p.problem?.message?.trim() || null;
  if (p.unavailable) {
    const { reason, canRestart } = p.unavailable;
    const line = reason === "damaged" && problem ? problem : UNAVAILABLE_LINES[reason];
    const tone: StatusTone = reason === "crashed" || reason === "damaged" ? "destructive" : "textSecondary";
    const action: ManagerAction = reason === "crashed" && canRestart ? "restart" : reason === "off" ? "turnOn" : "none";
    return { line, tone, command: null, action, menu: reason !== "updating" };
  }
  if (p.state === "notInstalled") return { line: "Not installed", tone: "textSecondary", command: p.install?.command || null, action: "check", menu: false };
  if (problem && OUTDATED.has(p.problem!.code)) return { line: problem, tone: "warning", command: p.install?.update || p.install?.command || null, action: "check", menu: false };
  if (p.state === "unavailable") return { line: problem ?? "Unavailable", tone: "destructive", command: null, action: "none", menu: true };
  if (p.state === "signedOut") {
    if (p.needs) return { line: "Signing in…", tone: "textSecondary", command: null, action: "continue", menu: false };
    return { line: problem ?? "Not signed in", tone: problem ? "warning" : "textSecondary", command: null, action: "signIn", menu: false };
  }
  const tone: StatusTone = problem ? "warning" : "textSecondary";
  if (p.state === "locked") return { line: problem ?? joined("Locked", p.account, server), tone, command: null, action: "unlock", menu: true };
  const connected = p.account ? `Connected as ${p.account}` : "Connected";
  return { line: problem ?? joined(connected, server), tone, command: null, action: "none", menu: true };
}
