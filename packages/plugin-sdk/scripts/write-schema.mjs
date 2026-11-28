#!/usr/bin/env node
import { build } from "esbuild";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP = `Writes docs/plugin.v3.schema.json from the SDK's manifest checks.
Usage: node packages/plugin-sdk/scripts/write-schema.mjs [--check]
  --check  exit 1 when the committed schema is out of date, without writing it
`;

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(HELP);
  process.exit(0);
}

const target = fileURLToPath(new URL("../../../docs/plugin.v3.schema.json", import.meta.url));
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/manifest.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  logLevel: "warning",
});
const source = bundled.outputFiles[0].text;
const { manifestV3SchemaJson } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const schema = manifestV3SchemaJson();

if (args.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== schema) {
    process.stderr.write("docs/plugin.v3.schema.json is out of date: run node packages/plugin-sdk/scripts/write-schema.mjs\n");
    process.exit(1);
  }
  process.stdout.write("docs/plugin.v3.schema.json is current\n");
} else {
  writeFileSync(target, schema);
  process.stdout.write(`wrote docs/plugin.v3.schema.json (${schema.length} bytes)\n`);
}
