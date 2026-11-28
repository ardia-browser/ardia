import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PLUGIN_ID_PATTERN, validateManifestV3 } from "@ardia/plugin-sdk/manifest";
import { CliError, shownPath, type Output } from "./output";
import { splitId } from "./project";
import { TEMPLATES, templateFiles, type TemplateName } from "./templates";
import { CLI_VERSION } from "./version";

export type InitFlags = { template?: string; id?: string; force?: boolean };

export type InitReport = { dir: string; id: string; template: TemplateName; files: string[] };

const slugOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "my-plugin";

const titleOf = (name: string) =>
  name
    .split("-")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ")
    .slice(0, 60) || "My Plugin";

export function initPlugin(dirArg: string | undefined, flags: InitFlags = {}): InitReport {
  const template = (flags.template ?? "ui") as TemplateName;
  if (!TEMPLATES.includes(template)) throw new CliError(`--template must be one of ${TEMPLATES.join(", ")}`);
  const dir = resolve(dirArg ?? ".");
  const id = flags.id ?? `@me/${slugOf(basename(dir))}`;
  if (!new RegExp(PLUGIN_ID_PATTERN).test(id)) throw new CliError(`--id must be a scoped id like @scope/name (lowercase letters, digits and dashes); got ${id}`);
  if (existsSync(dir) && readdirSync(dir).filter((name) => name !== ".git").length && !flags.force) {
    throw new CliError(`${dir} isn't empty; pick an empty folder or pass --force to write over the files the template makes`);
  }
  const { name } = splitId(id);
  const major = CLI_VERSION.split(".")[0];
  const files = templateFiles(template, { id, name, title: titleOf(name), sdkRange: `^${major}.0.0`, cliRange: `^${major}.0.0`, ardiaRange: ">=0.3.0" });
  const manifest = files.find((f) => f.path === "plugin.json")!;
  const checked = validateManifestV3(JSON.parse(manifest.content));
  if (!checked.ok) throw new CliError("The template made a plugin.json that doesn't pass its own checks", checked.problems);
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    if (file.executable) chmodSync(target, 0o755);
  }
  return { dir, id, template, files: files.map((f) => f.path) };
}

export function runInit(dirArg: string | undefined, out: Output, flags: InitFlags = {}): InitReport {
  const report = initPlugin(dirArg, flags);
  const where = shownPath(report.dir);
  out.result(
    [
      `made ${report.id} from the ${report.template} template in ${where}`,
      ...report.files.map((f) => `  ${f}`),
      "",
      "next:",
      ...(where === "." ? [] : [`  cd ${where}`]),
      "  npm install",
      "  npx ardia-plugin dev",
    ].join("\n"),
    report,
  );
  return report;
}
