import { build, context } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const sdk = (path) => fileURLToPath(new URL(`../../packages/plugin-sdk/src/${path}`, import.meta.url));
const dev = process.argv.includes("--dev");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const frozen = process.argv.find((a) => a.startsWith("--frozen="))?.slice(9);

const stripComments = (file) =>
  writeFileSync(
    file,
    readFileSync(file, "utf8")
      .replace(/\/\* @__PURE__ \*\/ /g, "")
      .split("\n")
      .filter((line) => !/^\s*\/\/ /.test(line))
      .join("\n"),
  );

const mainOptions = {
  entryPoints: [here("src/main/index.ts")],
  outfile: here("dist/index.js"),
  bundle: true,
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "@ardia/plugin-sdk",
  legalComments: "none",
  charset: "utf8",
  minify: !dev,
  alias: {
    "@ardia/plugin-sdk/jsx-runtime": sdk("jsxRuntime.ts"),
    "@ardia/plugin-sdk/jsx-dev-runtime": sdk("jsxRuntime.ts"),
    "@ardia/plugin-sdk": sdk("index.ts"),
  },
  logLevel: "warning",
};

const pageOptions = (entry, outdir, extra = {}) => ({
  entryPoints: [here(entry)],
  outdir,
  bundle: true,
  format: "esm",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  platform: "browser",
  target: ["safari17"],
  jsx: "automatic",
  legalComments: "none",
  charset: "utf8",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".png": "file", ".svg": "file" },
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
  logLevel: "warning",
  ...extra,
});

async function buildMain() {
  mkdirSync(here("dist"), { recursive: true });
  await build(mainOptions);
  stripComments(here("dist/index.js"));
}

async function buildPage() {
  mkdirSync(here("page"), { recursive: true });
  rmSync(here("page"), { recursive: true, force: true });
  mkdirSync(here("page"), { recursive: true });
  const result = await build(pageOptions("src/page/index.tsx", here("page"), { metafile: true, publicPath: "/page/" }));
  mkdirSync(here("dist"), { recursive: true });
  writeFileSync(here("dist/page-meta.json"), JSON.stringify(result.metafile));
  copyFileSync(here("src/page/index.html"), here("page/index.html"));
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm" };

async function serveFrozen(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(here("src/page/dev.html"), join(dir, "index.html"));
  await build(pageOptions("src/page/dev.tsx", dir));
  const port = Number(process.env.NOTES_DEV_PORT ?? 5199);
  createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(dir, path);
    const target = file.startsWith(dir) && existsSync(file) && statSync(file).isFile() ? file : join(dir, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(target)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(target));
  }).listen(port, "127.0.0.1", () => console.log(`notes frozen page on http://127.0.0.1:${port}/`));
}

if (dev && frozen) {
  await serveFrozen(frozen);
} else if (dev) {
  mkdirSync(here("dev-out"), { recursive: true });
  copyFileSync(here("src/page/dev.html"), here("dev-out/index.html"));
  const ctx = await context(pageOptions("src/page/dev.tsx", here("dev-out")));
  await ctx.watch();
  const port = Number(process.env.NOTES_DEV_PORT ?? 5199);
  const { hosts } = await ctx.serve({ servedir: here("dev-out"), port, fallback: here("dev-out/index.html") });
  console.log(`notes dev page on http://${hosts[0] ?? "127.0.0.1"}:${port}/`);
} else {
  if (!only || only === "main") await buildMain();
  if (!only || only === "page") await buildPage();
}
