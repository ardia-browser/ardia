import { DENIED_COMMANDS, GLOBAL_FLAGS } from "./credentialConstants";
import type { DeniedMatch } from "./credentialTypes";

export const VALUED_GLOBAL_FLAGS: Readonly<Record<string, readonly string[]>> = {
  op: ["--account", "--config", "--encoding", "--format", "--session"],
  bw: ["--session"],
  "pass-cli": ["--output"],
};

export const UNKNOWN_LEADING_OPTION = "an option Ardia doesn't know comes before the command";

export const DENIED_REASONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  op: {
    run: "runs other programs",
    inject: "runs other programs",
    plugin: "runs other programs",
    read: "writes files",
    "document get": "writes files",
    "service-account": "mints credentials",
    connect: "mints credentials",
    "events-api": "mints credentials",
    "item share": "shares data",
    update: "writes files",
  },
  bw: {
    serve: "opens a server",
    send: "shares data",
    export: "writes files",
    encode: "writes files",
    "get attachment": "writes files",
    import: "reads files",
    "create attachment": "reads files",
    receive: "writes files",
  },
  "pass-cli": { run: "runs other programs", inject: "runs other programs", "ssh-agent": "opens an agent" },
};

const flagName = (token: string) => token.split("=", 1)[0]!;

export const spellsFlag = (token: string, flag: string) => token === flag || token.startsWith(`${flag}=`) || (!flag.startsWith("--") && flag.length === 2 && token.startsWith(flag));

function afterGlobals(program: string, argv: readonly string[]): readonly string[] {
  const globals = GLOBAL_FLAGS[program] ?? [];
  const valued = VALUED_GLOBAL_FLAGS[program] ?? [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    const flag = flagName(token);
    if (!globals.includes(flag)) break;
    i += !token.includes("=") && valued.includes(flag) ? 2 : 1;
  }
  return argv.slice(i);
}

export function deniedMatch(program: string, argv: readonly string[]): DeniedMatch | null {
  const denied = DENIED_COMMANDS[program];
  if (!denied) return null;
  const rest = afterGlobals(program, argv);
  const first = rest[0];
  if (first !== undefined && first.startsWith("-")) return { argv: [flagName(first)], why: UNKNOWN_LEADING_OPTION };
  const words = rest.filter((token) => !token.startsWith("-"));
  for (const command of denied) {
    if (!command.argv.every((word, i) => rest[i] === word) && !command.argv.every((word, i) => words[i] === word)) continue;
    const why = DENIED_REASONS[program]?.[command.argv.join(" ")] ?? "runs other programs";
    if (!command.withFlags?.length) return { argv: command.argv, why: `it ${why}` };
    const flag = command.withFlags.find((f) => rest.some((token) => spellsFlag(token, f)));
    if (flag) return { argv: command.argv, flag, why: `it ${why}` };
  }
  return null;
}

export const deniedName = (program: string, denied: DeniedMatch) => `${program} ${denied.argv.join(" ")}${denied.flag ? ` with ${denied.flag}` : ""}`;

export const deniedRunName = (program: string, denied: DeniedMatch) => `${program} ${[...denied.argv, ...(denied.flag ? [denied.flag] : [])].join(" ")}`;
