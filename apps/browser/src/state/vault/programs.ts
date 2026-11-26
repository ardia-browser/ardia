import type { ControlPeer } from "../../platform/automation";

export type ProgramKind = "app" | "ardia" | "interpreter" | "unsigned" | "unknown";

export type Program = {
  name: string;
  path: string | null;
  signer: string | null;
  teamId: string | null;
  identifier: string | null;
  kind: ProgramKind;
  claimed: string | null;
};

const INTERPRETER = /^(node|nodejs|deno|bun|python[\d.]*|pypy[\d.]*|ruby|irb|perl[\d.]*|php|lua|luajit|java|osascript|swift|tclsh|wish|expect|bash|zsh|sh|dash|ksh|tcsh|csh|fish|nu|pwsh|env|xargs|script|login|sudo|Terminal|iTerm2|Ghostty|Warp|WezTerm|Alacritty|kitty)$/i;
const ARDIA_COMMAND = /\/Ardia\/Programs\/cli\/|\/Ardia\/CLI\//;

const baseName = (path: string | null | undefined) => (path ? (path.split("/").pop() ?? "") : "");

function kindOf(peer: ControlPeer): ProgramKind {
  if (!peer.path) return "unknown";
  const name = baseName(peer.path);
  if (ARDIA_COMMAND.test(peer.path) || name === "ardia" || peer.identifier === "ardia") return "ardia";
  if (INTERPRETER.test(name) || (peer.name && INTERPRETER.test(peer.name))) return "interpreter";
  if (!peer.signed || !peer.valid || peer.adhoc || !peer.teamId) return "unsigned";
  return "app";
}

export function programOf(peer: ControlPeer | null, claimed: string | null): Program {
  if (!peer) return { name: "an unknown program", path: null, signer: null, teamId: null, identifier: null, kind: "unknown", claimed };
  return {
    name: peer.name || baseName(peer.path) || `process ${peer.pid}`,
    path: peer.path ?? null,
    signer: peer.signed ? (peer.signer ?? null) : null,
    teamId: peer.teamId ?? null,
    identifier: peer.identifier ?? null,
    kind: kindOf(peer),
    claimed,
  };
}

export const mayAlwaysAllow = (program: Program) => program.kind === "app" && !!program.teamId && !!program.identifier;

export const programKey = (program: Program) => `${program.teamId ?? ""}\n${program.identifier ?? ""}`;

export function signerLine(program: Program): string {
  switch (program.kind) {
    case "app":
      return program.signer ? `Signed by ${program.signer}` : `Signed by team ${program.teamId}`;
    case "ardia":
      return "An agent asked through the ardia command. Ardia can't tell which agent it is.";
    case "interpreter":
      return program.signer ? `${program.name} runs scripts, so the script itself isn't known (${program.signer})` : `${program.name} runs scripts, so the script itself isn't known`;
    case "unsigned":
      return "Not signed by a known developer";
    case "unknown":
      return "Ardia couldn't check which program this is";
  }
}

export const programLabel = (program: Program) => (program.kind === "app" ? program.name : `${program.name}${program.kind === "unsigned" ? ", unsigned" : ""}`);
