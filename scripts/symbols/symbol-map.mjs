import { spawnSync } from "node:child_process";
import { functionSymbols, imageFor } from "./macho.mjs";

const MAP_HEADER = "# ardia-symbol-map 1";
const MAP_SOURCES = new Set(["dsym", "match"]);

const SWIFT = /^(\$[sSe]|_T0)/;
const CXX = /^_Z/;
const CXX_BLOCK = /^__(_Z.*)_block_invoke(?:_\d+)?$/;
const FOLDED = " (identical code folded)";

function machoName(name) {
  return name.startsWith("_") ? name.slice(1) : name;
}

function runDemangler(candidates, names) {
  for (const [command, args] of candidates) {
    const run = spawnSync(command, args, { input: names.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 30 });
    if (run.status !== 0 || run.error) continue;
    const lines = run.stdout.split("\n");
    if (lines.length >= names.length) return lines.slice(0, names.length);
  }
  return null;
}

const DEMANGLERS = {
  swift: [["swift-demangle", ["--simplified"]], ["xcrun", ["swift-demangle", "--simplified"]]],
  cxx: [["c++filt", []], ["llvm-cxxfilt", []], ["xcrun", ["c++filt"]]],
};

export function demangle(names, demanglers = DEMANGLERS) {
  const plain = names.map(machoName);
  const out = plain.slice();
  const groups = [
    ["swift", (i) => SWIFT.test(plain[i]), (i) => plain[i]],
    ["cxx", (i) => CXX.test(plain[i]) || CXX_BLOCK.test(plain[i]), (i) => plain[i].match(CXX_BLOCK)?.[1] ?? plain[i]],
  ];
  for (const [kind, wanted, input] of groups) {
    const indexes = plain.flatMap((_, i) => (wanted(i) ? [i] : []));
    if (!indexes.length) continue;
    const inputs = indexes.map(input);
    const named = runDemangler(demanglers[kind], inputs);
    if (!named) continue;
    indexes.forEach((i, k) => {
      if (!named[k] || named[k] === inputs[k]) return;
      out[i] = CXX_BLOCK.test(plain[i]) ? `invocation function for block in ${named[k]}` : named[k];
    });
  }
  return out;
}

export function buildMap(buffer, uuid, { demanglers } = {}) {
  const found = imageFor(buffer, uuid);
  if (!found) throw new Error(`no slice of this file has the UUID ${uuid}`);
  const { slice, image } = found;
  if (image.base == null || !image.text) throw new Error("the image has no __TEXT,__text section");
  const rank = (symbol) => (symbol.name.startsWith("<") ? 0 : 2) + (symbol.external ? 1 : 0);
  const textEnd = image.text.addr + image.text.size;
  const byAddress = new Map();
  for (const symbol of functionSymbols(slice, image)) {
    if (symbol.address < image.text.addr || symbol.address >= textEnd) continue;
    const held = byAddress.get(symbol.address);
    if (held) held.push(symbol);
    else byAddress.set(symbol.address, [symbol]);
  }
  const starts = [...byAddress.keys()].sort((a, b) => a - b);
  const unique = [...new Set([...byAddress.values()].flat().map((s) => s.name))];
  const demangled = new Map(demangle(unique, demanglers).map((name, i) => [unique[i], name]));
  const names = starts.map((address) => {
    const symbols = byAddress.get(address);
    const best = symbols.reduce((a, b) => (rank(b) > rank(a) ? b : a));
    const name = demangled.get(best.name);
    const distinct = new Set(symbols.filter((s) => !s.name.startsWith("<")).map((s) => demangled.get(s.name)));
    const folded = distinct.size > 1 || (symbols.some((s) => s.name.startsWith("<deduplicated_symbol>")) && !name.startsWith("<"));
    return folded ? `${name}${FOLDED}` : name;
  });
  const entries = starts.map((address, i) => ({
    start: address - image.base,
    end: (i + 1 < starts.length ? starts[i + 1] : textEnd) - image.base,
    name: names[i],
  }));
  return { uuid: image.uuid, arch: image.arch, source: "dsym", textStart: image.text.addr - image.base, textEnd: textEnd - image.base, entries };
}

const clean = (name) => name.replace(/[\t\n\r]/g, " ");

export function serializeMap(map) {
  const lines = [`${MAP_HEADER} ${map.uuid} ${map.arch} ${map.source} ${map.textStart.toString(16)} ${map.textEnd.toString(16)}`];
  for (const e of map.entries) lines.push(`${e.start.toString(16)}\t${e.end.toString(16)}\t${clean(e.name)}`);
  return lines.join("\n") + "\n";
}

const HEX = /^[0-9a-f]{1,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseMap(text) {
  const lines = text.split("\n");
  const head = lines[0]?.split(" ") ?? [];
  if (head.length !== 8 || head.slice(0, 3).join(" ") !== MAP_HEADER) throw new Error("not an Ardia symbol map");
  const [, , , uuid, arch, source, textStart, textEnd] = head;
  if (!UUID.test(uuid) || !HEX.test(textStart) || !HEX.test(textEnd) || !MAP_SOURCES.has(source) || parseInt(textEnd, 16) <= parseInt(textStart, 16)) throw new Error("the symbol map's header is malformed");
  const entries = [];
  let previousEnd = 0;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const [start, end, ...rest] = line.split("\t");
    if (!HEX.test(start) || !HEX.test(end) || !rest.length) throw new Error(`the symbol map has a malformed row: ${line.slice(0, 80)}`);
    const entry = { start: parseInt(start, 16), end: parseInt(end, 16), name: rest.join("\t") };
    if (entry.start < previousEnd || entry.end <= entry.start) throw new Error("the symbol map's rows aren't sorted, non-overlapping ranges");
    previousEnd = entry.end;
    entries.push(entry);
  }
  return { uuid, arch, source, textStart: parseInt(textStart, 16), textEnd: parseInt(textEnd, 16), entries };
}

export function lookup(map, offset) {
  if (!Number.isSafeInteger(offset) || offset < map.textStart || offset >= map.textEnd) return null;
  const { entries } = map;
  let lo = 0;
  let hi = entries.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].start <= offset) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0 || offset >= entries[found].end) return null;
  return { name: entries[found].name, delta: offset - entries[found].start };
}
