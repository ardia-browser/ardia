#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const [checksFile, outDirectory] = process.argv.slice(2);
if (!checksFile || !outDirectory) {
  console.error("usage: make-sync-checks.mjs <sync-runtime-checks.js> <out dir>");
  process.exit(2);
}

const resultsOf = async (source) => {
  const context = vm.createContext({ __host: { labEcho: (text) => `echo:${text}` } });
  vm.runInContext(source, context, { filename: "sync-runtime-checks.js" });
  return JSON.stringify(await vm.runInContext("ArdiaSyncChecks.run()", context));
};

const source = readFileSync(checksFile, "utf8");
const expected = await resultsOf(source);
mkdirSync(outDirectory, { recursive: true });
writeFileSync(resolve(outDirectory, "ardia-sync-checks.js"), source);
writeFileSync(resolve(outDirectory, "ardia-sync-checks.json"), expected);
