import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const pageScriptAsFunction = {
  name: "page-script",
  setup(builder) {
    builder.onLoad({ filter: /page_script\.js$/ }, async (args) => ({ contents: `export default ${(await readFile(args.path, "utf8")).trim().replace(/;$/, "")};`, loader: "js" }));
  },
};

await build({
  absWorkingDir: root,
  entryPoints: { "page-preload": "src/engine/pagePreload.ts", "window-preload": "src/engine/hostPreload.ts" },
  outdir: "out",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: "linked",
  logLevel: "warning",
  plugins: [pageScriptAsFunction],
});
