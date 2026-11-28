export type FlagSpec = Record<string, "string" | "boolean">;

export type Parsed = { positionals: string[]; flags: Record<string, string | boolean | undefined> };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgs(argv: readonly string[], spec: FlagSpec): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const long = arg.startsWith("--");
    const body = long ? arg.slice(2) : arg.slice(1);
    const eq = body.indexOf("=");
    let name = eq >= 0 ? body.slice(0, eq) : body;
    if (!long) name = SHORT[name] ?? name;
    const negated = name.startsWith("no-") && spec[name.slice(3)] === "boolean";
    const key = negated ? name.slice(3) : name;
    const kind = spec[key];
    if (!kind) throw new UsageError(`Unknown option ${arg}`);
    if (kind === "boolean") {
      if (eq >= 0) throw new UsageError(`--${key} takes no value`);
      flags[key] = !negated;
      continue;
    }
    const value = eq >= 0 ? body.slice(eq + 1) : argv[++i];
    if (value === undefined || (eq < 0 && value.startsWith("--"))) throw new UsageError(`--${key} needs a value`);
    flags[key] = value;
  }
  return { positionals, flags };
}

const SHORT: Record<string, string> = { h: "help", o: "out", t: "template", v: "version" };

export const str = (parsed: Parsed, key: string): string | undefined => {
  const value = parsed.flags[key];
  return typeof value === "string" ? value : undefined;
};

export const bool = (parsed: Parsed, key: string): boolean => parsed.flags[key] === true;
