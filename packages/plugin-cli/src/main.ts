import { bool, parseArgs, str, UsageError, type FlagSpec } from "./args";
import { runBuild } from "./build";
import { runCheck } from "./check";
import { runDev, type Env } from "./dev";
import { runInit } from "./init";
import { CliError, createOutput, type Streams } from "./output";
import { runPack } from "./pack";
import { loadProject } from "./project";
import { runRelease } from "./release";
import { TEMPLATES } from "./templates";
import { CLI_VERSION } from "./version";

export const HELP = `ardia-plugin ${CLI_VERSION}: make, check, build, pack and release Ardia plugins

Usage: ardia-plugin <command> [dir] [options]

Commands:
  init [dir]      Make a plugin from a template
                    --template ${TEMPLATES.join("|")}   (default ui)
                    --id @scope/name                  (default @me/<folder name>)
                    --force                           write into a folder that isn't empty
  check [dir]     Check plugin.json, the files it names and the pack's size
  build [dir]     Bundle main and the content scripts with esbuild
                    --minify  --sourcemap
  pack [dir]      Check, build and make a deterministic <name>/ .tar.gz with a .sha256 beside it
                    --out <file>  --platform <key>  --no-build
  dev [dir]       Build on every change, link the plugin into Ardia, reload it and show its log
                    --data-dir <dir>  --config-dir <dir>  --once  --no-tail
  release [dir]   Check, build, pack and publish a GitHub Release with gh
                    --tag <tag>  --prerelease  --draft  --dry-run  --platform <keys>  --repo owner/repo  --notes <text>

Options for every command:
  --json          Print the result as JSON on stdout
  --quiet         Print only the result
  -h, --help      Show this help
  -v, --version   Show the version

Progress goes to stderr and the result to stdout, so ardia-plugin pack --json | jq .sha256 works.
`;

const COMMON: FlagSpec = { json: "boolean", quiet: "boolean", help: "boolean", version: "boolean" };
const FLAGS: Record<string, FlagSpec> = {
  init: { template: "string", id: "string", force: "boolean" },
  check: {},
  build: { minify: "boolean", sourcemap: "boolean" },
  pack: { out: "string", platform: "string", build: "boolean", minify: "boolean", sourcemap: "boolean" },
  dev: { "data-dir": "string", "config-dir": "string", once: "boolean", tail: "boolean", minify: "boolean", sourcemap: "boolean" },
  release: { tag: "string", prerelease: "boolean", draft: "boolean", "dry-run": "boolean", platform: "string", repo: "string", notes: "string", minify: "boolean", sourcemap: "boolean" },
};

export type Signals = { once(signal: "SIGINT" | "SIGTERM", listener: () => void): void };

export type MainContext = { streams?: Streams; signals?: Signals; env?: Env };

export async function main(argv: readonly string[], context: MainContext = {}): Promise<number> {
  const streams = context.streams ?? process;
  const signals = context.signals ?? process;
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    streams.stdout.write(HELP);
    return command ? 0 : 64;
  }
  if (command === "-v" || command === "--version") {
    streams.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  const spec = FLAGS[command];
  if (!spec) {
    streams.stderr.write(`ardia-plugin: there's no command ${command}\n\n${HELP}`);
    return 64;
  }
  let parsed;
  try {
    parsed = parseArgs(rest, { ...COMMON, ...spec });
  } catch (error) {
    streams.stderr.write(`ardia-plugin ${command}: ${(error as Error).message}\n`);
    return 64;
  }
  if (bool(parsed, "help")) {
    streams.stdout.write(HELP);
    return 0;
  }
  if (parsed.positionals.length > 1) {
    streams.stderr.write(`ardia-plugin ${command}: takes one folder, got ${parsed.positionals.join(" ")}\n`);
    return 64;
  }
  const dir = parsed.positionals[0];
  const out = createOutput(bool(parsed, "json"), bool(parsed, "quiet"), streams);
  const build = { minify: bool(parsed, "minify"), sourcemap: bool(parsed, "sourcemap") };
  try {
    switch (command) {
      case "init":
        runInit(dir, out, { template: str(parsed, "template"), id: str(parsed, "id"), force: bool(parsed, "force") });
        return 0;
      case "check":
        return runCheck(dir, out).ok ? 0 : 1;
      case "build":
        await runBuild(loadProject(dir), out, build);
        return 0;
      case "pack":
        await runPack(dir, out, { ...build, out: str(parsed, "out"), platform: str(parsed, "platform"), skipBuild: parsed.flags.build === false });
        return 0;
      case "release":
        await runRelease(dir, out, {
          ...build,
          tag: str(parsed, "tag"),
          prerelease: bool(parsed, "prerelease"),
          draft: bool(parsed, "draft"),
          dryRun: bool(parsed, "dry-run"),
          platform: str(parsed, "platform"),
          repo: str(parsed, "repo"),
          notes: str(parsed, "notes"),
        });
        return 0;
      case "dev": {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signals.once("SIGINT", abort);
        signals.once("SIGTERM", abort);
        const session = await runDev(dir, out, {
          ...build,
          dataDir: str(parsed, "data-dir"),
          configDir: str(parsed, "config-dir"),
          once: bool(parsed, "once"),
          tail: parsed.flags.tail !== false,
          env: context.env ?? {},
          signal: controller.signal,
        });
        await session.done;
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof CliError) {
      streams.stderr.write(`ardia-plugin ${command}: ${error.message}\n${error.problems.map((p) => `  - ${p}\n`).join("")}`);
      if (out.json) streams.stdout.write(`${JSON.stringify({ ok: false, error: error.message, problems: error.problems }, null, 2)}\n`);
      return error.code;
    }
    if (error instanceof UsageError) {
      streams.stderr.write(`ardia-plugin ${command}: ${error.message}\n`);
      return 64;
    }
    streams.stderr.write(`ardia-plugin ${command}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 70;
  }
  return 0;
}
