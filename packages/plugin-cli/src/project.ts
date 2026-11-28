import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseManifestV3Json, type ManifestV3 } from "@ardia/plugin-sdk/manifest";
import { DEFAULT_IGNORES, globRule, type IgnoreRule } from "./files";
import { CliError } from "./output";

export type Project = { dir: string; manifest: ManifestV3; scope: string; name: string; packageJson: Record<string, unknown> | null };

export const MANIFEST_FILE = "plugin.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;

export function splitId(id: string): { scope: string; name: string } {
  const [scope = "", name = ""] = id.slice(1).split("/");
  return { scope, name };
}

export function loadProject(dirArg: string | undefined): Project {
  const dir = resolve(dirArg ?? ".");
  const file = join(dir, MANIFEST_FILE);
  if (!existsSync(file)) throw new CliError(`There's no ${MANIFEST_FILE} in ${dir}. Run ardia-plugin init to make one.`);
  const source = readFileSync(file);
  if (source.length > MAX_MANIFEST_BYTES) throw new CliError(`${MANIFEST_FILE} is larger than 1 MB.`);
  const parsed = parseManifestV3Json(source.toString("utf8"));
  if (!parsed.ok) throw new CliError(`${MANIFEST_FILE} has ${parsed.problems.length} problem${parsed.problems.length === 1 ? "" : "s"}`, parsed.problems);
  let packageJson: Record<string, unknown> | null = null;
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      packageJson = JSON.parse(readFileSync(pkg, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new CliError(`package.json isn't JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { dir, manifest: parsed.manifest, ...splitId(parsed.manifest.id), packageJson };
}

export function referencedFiles(manifest: ManifestV3): { path: string; what: string; executable?: boolean }[] {
  const out: { path: string; what: string; executable?: boolean }[] = [];
  const c = manifest.contributes ?? {};
  if (manifest.main) out.push({ path: manifest.main, what: "main" });
  const program = manifest.sidecar?.run[0];
  if (program !== undefined) out.push({ path: program, what: "sidecar.run[0]", executable: true });
  c.contentScripts?.forEach((script, i) => {
    script.js.forEach((path, j) => out.push({ path, what: `contributes.contentScripts[${i}].js[${j}]` }));
    script.css?.forEach((path, j) => out.push({ path, what: `contributes.contentScripts[${i}].css[${j}]` }));
  });
  c.pageStyles?.forEach((style, i) => out.push({ path: style.css, what: `contributes.pageStyles[${i}].css` }));
  if (c.netRules) out.push({ path: c.netRules, what: "contributes.netRules" });
  c.themes?.forEach((theme, i) => out.push({ path: theme.file, what: `contributes.themes[${i}].file` }));
  c.programs?.forEach((program, i) => out.push({ path: program.path, what: `contributes.programs[${i}].path`, executable: true }));
  c.panels?.forEach((panel, i) => {
    if (panel.file) out.push({ path: panel.file.replace(/[?#].*$/, ""), what: `contributes.panels[${i}].file` });
  });
  return out;
}

const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".mts"];

export function entrySources(project: Project): Map<string, string> {
  const configured = (project.packageJson?.ardiaPlugin as { entries?: Record<string, string> } | undefined)?.entries ?? {};
  const outputs = new Set<string>();
  if (project.manifest.main) outputs.add(project.manifest.main);
  for (const script of project.manifest.contributes?.contentScripts ?? []) for (const js of script.js) outputs.add(js);
  const map = new Map<string, string>();
  for (const output of outputs) {
    const given = configured[output];
    if (given) {
      map.set(output, given);
      continue;
    }
    const built = /^dist\/(.+)\.(?:m?js|cjs)$/.exec(output);
    if (!built) continue;
    const stem = built[1]!;
    const found = SOURCE_EXTENSIONS.map((ext) => `src/${stem}${ext}`).find((candidate) => existsSync(join(project.dir, candidate)));
    if (found) map.set(output, found);
  }
  return map;
}

export function ignoreRules(dir: string): IgnoreRule[] {
  const extra = existsSync(join(dir, ".ardiaignore"))
    ? readFileSync(join(dir, ".ardiaignore"), "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    : [];
  return [...DEFAULT_IGNORES, ...extra].map(globRule);
}
