import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const sdk = (path) => fileURLToPath(new URL(`../../../../../../plugin-sdk/src/${path}`, import.meta.url));
const outfile = process.argv[2] ? resolve(process.argv[2]) : here("dist/index.js");

await build({
  entryPoints: [here("src/index.tsx")],
  outfile,
  bundle: true,
  format: "iife",
  platform: "neutral",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "@ardia/plugin-sdk",
  legalComments: "none",
  charset: "utf8",
  alias: {
    "@ardia/plugin-sdk/jsx-runtime": sdk("jsxRuntime.ts"),
    "@ardia/plugin-sdk/jsx-dev-runtime": sdk("jsxRuntime.ts"),
    "@ardia/plugin-sdk": sdk("index.ts"),
  },
  logLevel: "warning",
});

const bundled = readFileSync(outfile, "utf8")
  .replace(/\/\* @__PURE__ \*\/ /g, "")
  .split("\n")
  .filter((line) => !/^\s*\/\/ /.test(line))
  .join("\n");
writeFileSync(outfile, bundled);
