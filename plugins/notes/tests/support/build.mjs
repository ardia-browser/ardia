import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let loaded = null;

export function load() {
  loaded ??= (async () => {
    const dir = join(tmpdir(), "ardia-notes-tests");
    mkdirSync(dir, { recursive: true });
    const outfile = join(dir, `entry-${process.pid}-${Date.now()}.mjs`);
    await build({
      entryPoints: [fileURLToPath(new URL("./entry.ts", import.meta.url))],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      logLevel: "warning",
      alias: { "@ardia/plugin-sdk": fileURLToPath(new URL("../../../../packages/plugin-sdk/src/index.ts", import.meta.url)) },
    });
    return import(pathToFileURL(outfile).href);
  })();
  return loaded;
}

export async function until(check, ms = 5000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
