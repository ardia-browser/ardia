import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PLATFORM_KEYS, type PlatformKey } from "@ardia/plugin-sdk/manifest";
import { isNativeTier } from "@ardia/plugin-sdk/registry";
import { runBuild, type BuildFlags } from "./build";
import { checkProject, packedFiles } from "./check";
import { limitsForTier } from "./files";
import { CliError, formatBytes, shownPath, type Output } from "./output";
import { loadProject, type Project } from "./project";
import { gzipDeterministic, TarError, tarBytes, type TarEntry } from "./tar";

export type PackReport = {
  id: string;
  version: string;
  platform: PlatformKey;
  file: string;
  sha256: string;
  bytes: number;
  unpackedBytes: number;
  files: number;
  root: string;
};

export type PackFlags = BuildFlags & { out?: string; platform?: string; skipBuild?: boolean };

export function parsePlatform(value: string | undefined): PlatformKey {
  if (value === undefined) return "universal";
  if ((PLATFORM_KEYS as readonly string[]).includes(value)) return value as PlatformKey;
  throw new CliError(`--platform must be one of ${PLATFORM_KEYS.join(", ")}`);
}

export function assetName(project: Project, platform: PlatformKey): string {
  const release = project.manifest.release;
  const shared = release?.asset && (platform === "universal" || release.asset.includes("{platform}")) ? release.asset : undefined;
  const template = release?.assets?.[platform] ?? shared ?? (platform === "universal" ? "{name}-{version}.tar.gz" : "{name}-{version}-{platform}.tar.gz");
  return template.replace(/\{version\}/g, project.manifest.version).replace(/\{platform\}/g, platform).replace(/\{name\}/g, project.name);
}

export function packEntries(project: Project): { entries: TarEntry[]; unpackedBytes: number; files: number } {
  const walked = packedFiles(project);
  if (walked.problems.length) throw new CliError("The plugin's folder can't be packed", walked.problems);
  const root = project.name;
  const entries: TarEntry[] = [{ path: root, type: "directory", mode: 0o755 }];
  const items = [
    ...walked.directories.map((path) => ({ path, directory: true, executable: false })),
    ...walked.files.map((file) => ({ path: file.path, directory: false, executable: file.executable })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let unpackedBytes = 0;
  for (const item of items) {
    if (item.directory) {
      entries.push({ path: `${root}/${item.path}`, type: "directory", mode: 0o755 });
      continue;
    }
    const data = readFileSync(join(project.dir, item.path));
    unpackedBytes += data.length;
    entries.push({ path: `${root}/${item.path}`, type: "file", mode: item.executable ? 0o755 : 0o644, data });
  }
  return { entries, unpackedBytes, files: walked.files.length };
}

export async function packProject(project: Project, out: Output, flags: PackFlags = {}): Promise<PackReport> {
  const platform = parsePlatform(flags.platform);
  if (!flags.skipBuild) await runBuild(project, { ...out, result: () => undefined }, flags);
  const report = checkProject(project, { built: true });
  for (const warning of report.warnings) out.warn(warning);
  if (!report.ok) throw new CliError(`${project.manifest.id} can't be packed`, report.problems);
  const { entries, unpackedBytes, files } = packEntries(project);
  let archive: Buffer;
  try {
    archive = gzipDeterministic(tarBytes(entries));
  } catch (error) {
    if (error instanceof TarError) throw new CliError(error.message);
    throw error;
  }
  const limits = limitsForTier(isNativeTier(project.manifest));
  if (archive.length > limits.packedBytes) throw new CliError(`The pack is ${formatBytes(archive.length)}; the limit is ${formatBytes(limits.packedBytes)}`);
  const file = resolve(flags.out ?? join(project.dir, "release", assetName(project, platform)));
  const sha256 = createHash("sha256").update(archive).digest("hex");
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.partial-${process.pid}`;
  writeFileSync(partial, archive);
  renameSync(partial, file);
  writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
  return { id: project.manifest.id, version: project.manifest.version, platform, file, sha256, bytes: archive.length, unpackedBytes, files, root: `${project.name}/` };
}

export async function runPack(dir: string | undefined, out: Output, flags: PackFlags = {}): Promise<PackReport> {
  const project = loadProject(dir);
  const report = await packProject(project, out, flags);
  const shown = shownPath(report.file);
  out.result(
    [
      `packed ${report.id}@${report.version} (${report.platform})`,
      `  file    ${shown}`,
      `  sha256  ${report.sha256}`,
      `  size    ${formatBytes(report.bytes)} (${formatBytes(report.unpackedBytes)} unpacked, ${report.files} files under ${report.root})`,
    ].join("\n"),
    report,
  );
  return report;
}
