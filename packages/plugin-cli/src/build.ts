import { context, build as esbuild, type BuildOptions, type BuildResult, type Message } from "esbuild";
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, type Output } from "./output";
import { entrySources, type Project } from "./project";

export type BuildReport = { ok: boolean; outputs: { entry: string; source: string; bytes: number }[]; errors: string[]; warnings: string[] };

export type BuildFlags = { minify?: boolean; sourcemap?: boolean };

const SDK = "@ardia/plugin-sdk";

function exportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["import", "default"]) if (typeof record[key] === "string") return record[key] as string;
  }
  return null;
}

function bundledSdkAliases(): Record<string, string> {
  let pkgPath: string;
  try {
    pkgPath = createRequire(fileURLToPath(import.meta.url)).resolve(`${SDK}/package.json`);
  } catch {
    return {};
  }
  const root = dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { exports?: Record<string, unknown> };
  const aliases: Record<string, string> = {};
  for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
    const target = exportTarget(value);
    if (!target || subpath.endsWith("package.json")) continue;
    aliases[subpath === "." ? SDK : `${SDK}${subpath.slice(1)}`] = resolve(root, target);
  }
  return aliases;
}

function projectHasSdk(dir: string): boolean {
  try {
    createRequire(join(dir, "package.json")).resolve(`${SDK}/package.json`);
    return true;
  } catch {
    return false;
  }
}

export function buildOptions(project: Project, output: string, source: string, flags: BuildFlags = {}): BuildOptions {
  return {
    entryPoints: [`./${source}`],
    outfile: join(project.dir, output),
    bundle: true,
    format: "iife",
    platform: "neutral",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: SDK,
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
    charset: "utf8",
    legalComments: "none",
    minifyWhitespace: true,
    minifyIdentifiers: flags.minify === true,
    minifySyntax: flags.minify === true,
    sourcemap: flags.sourcemap === true ? "linked" : false,
    write: false,
    logLevel: "silent",
    absWorkingDir: project.dir,
    alias: projectHasSdk(project.dir) ? {} : bundledSdkAliases(),
  };
}

export function unsafeOutput(root: string, file: string): string | null {
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return `${file} is outside the plugin's folder`;
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      return null;
    }
    if (stats.isSymbolicLink()) return `${rel.split(sep).join("/")} goes through a symlink (${relative(root, current).split(sep).join("/")}); the build won't write through it`;
  }
  return null;
}

function writeOutputs(root: string, result: BuildResult): string[] {
  const problems: string[] = [];
  for (const file of result.outputFiles ?? []) {
    const refused = unsafeOutput(root, file.path);
    if (refused) {
      problems.push(refused);
      continue;
    }
    mkdirSync(dirname(file.path), { recursive: true });
    const again = unsafeOutput(root, file.path);
    if (again) {
      problems.push(again);
      continue;
    }
    const partial = `${file.path}.partial-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(partial, file.contents, { flag: "wx" });
    renameSync(partial, file.path);
  }
  return problems;
}

const messageText = (m: Message) => (m.location ? `${m.location.file}:${m.location.line}:${m.location.column}: ${m.text}` : m.text);

type Built = { entry: string; source: string; bytes: number; errors: string[]; warnings: string[] };

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function builtOf(project: Project, entry: string, source: string, result: BuildResult | null, failure?: { errors?: Message[]; warnings?: Message[] }): Built {
  return {
    entry,
    source,
    bytes: result && !result.errors.length ? sizeOf(join(project.dir, entry)) : 0,
    errors: (failure?.errors ?? result?.errors ?? []).map(messageText),
    warnings: (failure?.warnings ?? result?.warnings ?? []).map(messageText),
  };
}

const combine = (built: readonly Built[]): BuildReport => ({
  ok: built.every((b) => b.errors.length === 0),
  outputs: built.map(({ entry, source, bytes }) => ({ entry, source, bytes })),
  errors: built.flatMap((b) => b.errors),
  warnings: built.flatMap((b) => b.warnings),
});

async function buildOne(project: Project, entry: string, source: string, flags: BuildFlags): Promise<Built> {
  try {
    return settledBuild(project, entry, source, await esbuild(buildOptions(project, entry, source, flags)));
  } catch (error) {
    return failedBuild(project, entry, source, error);
  }
}

function failedBuild(project: Project, entry: string, source: string, error: unknown): Built {
  const shaped = error as { errors?: unknown; warnings?: unknown };
  if (Array.isArray(shaped?.errors) && shaped.errors.length) return builtOf(project, entry, source, null, shaped as { errors: Message[]; warnings?: Message[] });
  const message = error instanceof Error ? `${entry}: ${error.message}` : `${entry}: ${String(error)}`;
  return { entry, source, bytes: 0, errors: [message], warnings: [] };
}

function settledBuild(project: Project, entry: string, source: string, result: BuildResult): Built {
  try {
    const refused = result.errors.length ? [] : writeOutputs(project.dir, result);
    const built = builtOf(project, entry, source, result);
    return refused.length ? { ...built, bytes: 0, errors: [...built.errors, ...refused] } : built;
  } catch (error) {
    return failedBuild(project, entry, source, error);
  }
}

export async function buildProject(project: Project, flags: BuildFlags = {}): Promise<BuildReport> {
  const entries = [...entrySources(project)];
  return combine(await Promise.all(entries.map(([entry, source]) => buildOne(project, entry, source, flags))));
}

export async function watchProject(project: Project, flags: BuildFlags, onBuild: (report: BuildReport) => void): Promise<{ dispose(): Promise<void> }> {
  const entries = [...entrySources(project)];
  const latest = new Map<string, Built>();
  const contexts = await Promise.all(
    entries.map(([entry, source]) =>
      context({
        ...buildOptions(project, entry, source, flags),
        plugins: [
          {
            name: "ardia-plugin-report",
            setup(build) {
              build.onEnd((result) => {
                latest.set(entry, settledBuild(project, entry, source, result));
                if (latest.size === entries.length) onBuild(combine([...latest.values()]));
              });
            },
          },
        ],
      }),
    ),
  );
  if (!entries.length) onBuild(combine([]));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  return { dispose: async () => void (await Promise.all(contexts.map((ctx) => ctx.dispose()))) };
}

export async function runBuild(project: Project, out: Output, flags: BuildFlags = {}): Promise<BuildReport> {
  const report = await buildProject(project, flags);
  for (const warning of report.warnings) out.warn(warning);
  if (!report.ok) throw new CliError("The build failed", report.errors);
  const lines = report.outputs.length ? report.outputs.map((o) => `built ${o.entry} from ${o.source} (${o.bytes} bytes)`) : ["nothing to build: plugin.json names no dist/ entries with sources in src/"];
  out.result(lines.join("\n"), report);
  return report;
}
