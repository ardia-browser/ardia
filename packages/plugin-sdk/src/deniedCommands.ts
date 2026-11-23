import { DENIED_COMMANDS, GLOBAL_FLAGS } from "./credentialConstants";
import type { DeniedCommand } from "./credentialTypes";

export const VALUED_GLOBAL_FLAGS: Readonly<Record<string, readonly string[]>> = {
  op: ["--account", "--config", "--encoding", "--format", "--session"],
  bw: ["--session"],
  "pass-cli": ["--output"],
};

export const DENIED_REASONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  op: { run: "runs other programs", inject: "runs other programs", plugin: "runs other programs", read: "writes files", "document get": "writes files", "service-account": "mints credentials" },
  bw: { serve: "opens a server", send: "shares data", export: "writes files", encode: "shares data", "get attachment": "writes files" },
  "pass-cli": { run: "runs other programs", inject: "runs other programs", "ssh-agent": "opens an agent" },
};

function positionals(program: string, argv: readonly string[]): string[] {
  const globals = GLOBAL_FLAGS[program] ?? [];
  const valued = VALUED_GLOBAL_FLAGS[program] ?? [];
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("-")) {
      out.push(token);
      continue;
    }
    const flag = token.split("=", 1)[0]!;
    if (globals.includes(flag) && valued.includes(flag) && !token.includes("=")) i++;
  }
  return out;
}

export function deniedMatch(program: string, argv: readonly string[]): DeniedCommand | null {
  const leading = positionals(program, argv);
  for (const denied of DENIED_COMMANDS[program] ?? []) {
    if (!denied.argv.every((word, i) => leading[i] === word)) continue;
    const flagged = denied.withFlag === undefined || argv.some((token) => token === denied.withFlag || token.startsWith(`${denied.withFlag}=`));
    if (flagged) return denied;
  }
  return null;
}

export const deniedName = (program: string, denied: DeniedCommand) => `${program} ${denied.argv.join(" ")}${denied.withFlag ? ` with ${denied.withFlag}` : ""}`;

export const deniedReason = (program: string, denied: DeniedCommand) => DENIED_REASONS[program]?.[denied.argv.join(" ")] ?? "runs other programs";
