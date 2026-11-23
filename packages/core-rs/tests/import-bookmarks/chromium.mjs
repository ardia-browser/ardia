import { registerHooks } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});

const [source, profile] = process.argv.slice(2);
const { chromiumBookmarks } = await import(pathToFileURL(`${source}/chromium.ts`).href);
const real = (path) => path.replace(/\\/g, "/");
const textOf = (bytes) => {
  let body = bytes;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252", { ignoreBOM: true }).decode(body);
  }
};
const host = {
  list: async (path) => readdirSync(real(path)).map((name) => ({ name, dir: false, size: 0, modified: 0 })),
  readText: async (path, largest) => {
    const file = real(path);
    if (statSync(file).size > largest) return null;
    return textOf(readFileSync(file));
  },
};
try {
  process.stdout.write(JSON.stringify({ ok: await chromiumBookmarks(host, profile) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.code ?? String(error) }));
}
