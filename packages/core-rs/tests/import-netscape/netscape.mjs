import { registerHooks } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});

const LARGEST_FILE_BYTES = 64 << 20;
const [source, file] = process.argv.slice(2);
const { bookmarksFromHtml } = await import(pathToFileURL(`${source}/fileFormats.ts`).href);
const textOf = (bytes) => {
  let body = bytes;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252", { ignoreBOM: true }).decode(body);
  }
};
try {
  if (statSync(file).size > LARGEST_FILE_BYTES) throw Object.assign(new Error("The file could not be read"), { code: "unreadable" });
  const tree = bookmarksFromHtml(textOf(readFileSync(file)), basename(file));
  process.stdout.write(JSON.stringify({ ok: tree }, (key, value) => (typeof value === "string" ? value.toWellFormed() : value)));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.code ?? String(error) }));
}
