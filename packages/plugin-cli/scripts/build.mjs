import { build } from "esbuild";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: { cli: join(root, "bin/ardia-plugin.ts"), create: join(root, "bin/create-ardia-plugin.ts") },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["esbuild", "@ardia/plugin-sdk", "@ardia/plugin-sdk/*"],
  alias: {
    "@ardia/plugin-sdk/manifest": join(root, "../plugin-sdk/src/manifest.ts"),
    "@ardia/plugin-sdk/semver": join(root, "../plugin-sdk/src/semver.ts"),
  },
  banner: { js: "#!/usr/bin/env node" },
  chunkNames: "chunks/[name]-[hash]",
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
});

for (const name of ["cli.js", "create.js"]) chmodSync(join(dist, name), 0o755);
process.stdout.write("@ardia/plugin-cli: built dist/cli.js and dist/create.js\n");
