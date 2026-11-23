#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { imageFor } from "./macho.mjs";
import { nameStripped, parseObjc } from "./stripped.mjs";
import { serializeMap } from "./symbol-map.mjs";

const HELP = `Writes a symbol map for a shipped, stripped Mac build that has no dSYM, from a nearby build that has one.

  node scripts/symbols/name-stripped-build.mjs --target <stripped binary> --sibling <binary> --dsym <DWARF file> --out <map.tsv.gz>

Each function of --target (from its LC_FUNCTION_STARTS) gets a name three ways, best first:
  - its Objective-C method name, from the target's own class tables (dyld_info -objc; exact);
  - the name of the one function in --sibling whose code is identical once PC-relative fields are masked (exact
    unless two functions share that code, which are skipped);
  - for code that changed, the name of the sibling function in the same slot between two identical neighbours,
    marked "(by position)".
Functions none of these name are left out, so their frames stay raw. The map's source is "match". Upload it as
<app>-<version>-symbol-map.tsv.gz on that version's release (or pass its folder to symbolicate-frames.mjs --maps).`;

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    sibling: { type: "string" },
    dsym: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  console.log(HELP);
  process.exit(0);
}
for (const key of ["target", "sibling", "dsym", "out"]) {
  if (!values[key]) {
    console.error(`error: --${key} is required (--help)`);
    process.exit(1);
  }
}

function objcNames(path, base, arch) {
  const run = spawnSync("dyld_info", ["-arch", arch, "-objc", path], { encoding: "utf8", maxBuffer: 1 << 28 });
  const names = new Map();
  if (run.status !== 0) {
    console.error("warning: dyld_info -objc failed, so no Objective-C names from the target itself");
    return names;
  }
  return parseObjc(run.stdout, base);
}

const targetBuffer = readFileSync(values.target);
const found = imageFor(targetBuffer, null, "arm64");
if (!found) {
  console.error(`error: ${values.target} has no arm64 slice`);
  process.exit(1);
}
const { map, counts, functions } = nameStripped({
  targetBuffer,
  siblingBuffer: readFileSync(values.sibling),
  dsymBuffer: readFileSync(values.dsym),
  objc: objcNames(values.target, found.image.base, found.image.arch),
});
writeFileSync(values.out, values.out.endsWith(".gz") ? gzipSync(serializeMap(map)) : serializeMap(map));
console.error(`${map.uuid}: ${functions} functions, named ${counts.objc} from Objective-C, ${counts.code} by identical code, ${counts.position} by position; ${counts.none} left unnamed`);
