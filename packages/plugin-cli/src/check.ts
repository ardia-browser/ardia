import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isNativeTier } from "@ardia/plugin-sdk/registry";
import { insidePath, limitProblems, limitsForTier, walkPluginFiles, type FileEntry } from "./files";
import { formatBytes, type Output } from "./output";
import { entrySources, ignoreRules, loadProject, referencedFiles, type Project } from "./project";

export type CheckReport = {
  ok: boolean;
  id: string;
  version: string;
  problems: string[];
  warnings: string[];
  files: number;
  bytes: number;
};

export type CheckOptions = { built?: boolean };

export function packedFiles(project: Project): { files: FileEntry[]; directories: string[]; problems: string[] } {
  const keep = new Set(["plugin.json", ...referencedFiles(project.manifest).map((ref) => ref.path)]);
  return walkPluginFiles(project.dir, ignoreRules(project.dir), keep);
}

function jsonProblems(dir: string, path: string, what: string): string[] {
  try {
    JSON.parse(readFileSync(join(dir, path), "utf8"));
    return [];
  } catch (error) {
    return [`${what}: ${path} isn't JSON (${error instanceof Error ? error.message : String(error)})`];
  }
}

export function checkProject(project: Project, options: CheckOptions = {}): CheckReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const sources = entrySources(project);
  for (const ref of referencedFiles(project.manifest)) {
    const found = insidePath(project.dir, ref.path);
    if (!found.ok) {
      const source = sources.get(ref.path);
      if (found.reason === "doesn't exist" && source && !options.built) warnings.push(`${ref.what}: ${ref.path} isn't built yet; ardia-plugin build makes it from ${source}`);
      else problems.push(`${ref.what}: ${ref.path} ${found.reason}`);
      continue;
    }
    if (ref.executable && (found.stats.mode & 0o100) === 0) problems.push(`${ref.what}: ${ref.path} isn't executable (chmod +x ${ref.path})`);
    if (ref.path.endsWith(".json")) problems.push(...jsonProblems(project.dir, ref.path, ref.what));
  }
  const walked = packedFiles(project);
  problems.push(...walked.problems, ...limitProblems(walked.files, walked.directories, limitsForTier(isNativeTier(project.manifest))));
  const bytes = walked.files.reduce((sum, f) => sum + f.size, 0);
  if (project.packageJson && typeof project.packageJson.version === "string" && project.packageJson.version !== project.manifest.version) {
    warnings.push(`package.json's version ${project.packageJson.version} isn't plugin.json's ${project.manifest.version}`);
  }
  return { ok: problems.length === 0, id: project.manifest.id, version: project.manifest.version, problems, warnings, files: walked.files.length, bytes };
}

export function runCheck(dir: string | undefined, out: Output, options: CheckOptions = {}): CheckReport {
  const project = loadProject(dir);
  const report = checkProject(project, options);
  for (const warning of report.warnings) out.warn(warning);
  const lines = report.ok
    ? [`${report.id}@${report.version} looks good: ${report.files} files, ${formatBytes(report.bytes)}`]
    : [`${report.id}@${report.version} has ${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}:`, ...report.problems.map((p) => `  - ${p}`)];
  out.result(lines.join("\n"), report);
  return report;
}
