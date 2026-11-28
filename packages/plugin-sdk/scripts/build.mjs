import { build } from "esbuild";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");
const ENTRIES = ["index", "jsxRuntime", "protocol", "manifest", "registry", "semver", "testing"];

rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: Object.fromEntries(ENTRIES.map((name) => [name, join(src, `${name}.ts`)])),
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  legalComments: "none",
  charset: "utf8",
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "warning",
});

const ts = createRequire(import.meta.url)("typescript");
const sources = readdirSync(src).filter((name) => name.endsWith(".ts") && !name.endsWith(".typecheck.ts")).map((name) => join(src, name));
const program = ts.createProgram(sources, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts"],
  types: [],
  strict: true,
  noUncheckedIndexedAccess: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  declaration: true,
  emitDeclarationOnly: true,
  removeComments: true,
  outDir: dist,
  rootDir: src,
});
const emitted = program.emit();
const failures = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics);
if (failures.length) {
  const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => "\n" };
  process.stderr.write(ts.formatDiagnostics(failures, host));
  process.exit(1);
}

for (const name of readdirSync(dist).filter((file) => file.endsWith(".d.ts"))) {
  const path = join(dist, name);
  const text = readFileSync(path, "utf8").replace(/(from\s+|import\()(["'])(\.\/[^"']+?)\2/g, (whole, lead, quote, spec) => (spec.endsWith(".js") ? whole : `${lead}${quote}${spec}.js${quote}`));
  writeFileSync(path, text);
}

const files = readdirSync(dist, { recursive: true }).filter((file) => typeof file === "string" && (file.endsWith(".js") || file.endsWith(".d.ts")));
process.stdout.write(`@ardia/plugin-sdk: built ${files.length} files into dist/\n`);
