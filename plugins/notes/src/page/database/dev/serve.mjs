import { context } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = process.env.DB_DEV_OUT ?? here("../../../../dev-out/db");
mkdirSync(out, { recursive: true });
copyFileSync(here("index.html"), `${out}/index.html`);
const ctx = await context({
  entryPoints: [here("harness.tsx")],
  outdir: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["safari17"],
  jsx: "automatic",
  sourcemap: "inline",
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".png": "file", ".svg": "file" },
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
  logLevel: "warning",
});
if (process.argv.includes("--once")) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
  const port = Number(process.env.DB_DEV_PORT ?? 5299);
  const { hosts } = await ctx.serve({ servedir: out, port, fallback: `${out}/index.html` });
  console.log(`database harness on http://${hosts[0] ?? "127.0.0.1"}:${port}/`);
}
