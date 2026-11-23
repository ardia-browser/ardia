import { build } from "esbuild";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const vendored = here("vendor/plugin-sdk");
export const sdkRoot = existsSync(vendored) ? vendored : here("../..");
const sdk = (path) => `${sdkRoot}/src/${path}`;

export const sdkAliases = {
  "@ardia/plugin-sdk/credentials": sdk("credentials.ts"),
  "@ardia/plugin-sdk/testing": sdk("testing.ts"),
};

const shared = { bundle: true, platform: "neutral", target: "es2022", legalComments: "none", charset: "utf8", alias: sdkAliases, logLevel: "warning" };

export async function bundleForTests(contents) {
  const built = await build({ ...shared, stdin: { contents, resolveDir: here("."), loader: "ts" }, format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build({ ...shared, entryPoints: [here("src/index.ts")], outfile: here("dist/main.js"), format: "iife", minifySyntax: true });
}
