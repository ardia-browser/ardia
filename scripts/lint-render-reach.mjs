#!/usr/bin/env node
// Usage: node scripts/lint-render-reach.mjs [--depth N] [--json] [paths...]
// Reports blocking calls (file and socket I/O, keychain, channel waits, block_on, sleeps)
// that a render body or window-open path reaches through same-crate calls, N levels deep (default 4).
// Direct calls in render bodies are the blocking-in-render ast-grep rule; this pass follows the calls.
// Accepted findings live in tools/lint-rules/reach-allow.txt as "<file>::<function> <reason>".

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reachConfig = join(root, "tools/lint-rules/reach-sgconfig.yml");
const allowFile = join(root, "tools/lint-rules/reach-allow.txt");
const rootName = /^(render|render_root|open_(\w+_)?window(_\w+)?)$/;
const maxCandidates = 4;

function parseArgs(argv) {
  const options = { depth: 4, json: false, paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--depth") options.depth = Number(argv[++index] ?? 4);
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 6).map((line) => line.replace(/^\/\/ ?/, "")).join("\n") + "\n");
      process.exit(0);
    } else options.paths.push(arg);
  }
  if (options.paths.length === 0) options.paths = ["crates"];
  if (!Number.isInteger(options.depth) || options.depth < 1) options.depth = 4;
  return options;
}

function scan(paths) {
  return new Promise((done) => {
    const child = spawn("ast-grep", ["scan", "-c", reachConfig, "--json=stream", ...paths], { cwd: root });
    const chunks = [];
    const problems = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => problems.push(chunk));
    child.on("error", (error) => {
      process.stderr.write(`lint-render-reach: ast-grep is not available (${error.message}); install it with brew install ast-grep\n`);
      process.exit(2);
    });
    child.on("close", (code) => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (code !== 0 && !text) {
        process.stderr.write(Buffer.concat(problems).toString("utf8"));
        process.exit(2);
      }
      done(text.split("\n").filter(Boolean).map(slim));
    });
  });
}

const rangeField = /"range":\{"byteOffset":\{"start":(\d+),"end":(\d+)\},"start":\{"line":(\d+)/;
const fileField = /"file":"((?:[^"\\]|\\.)*)"/;
const ruleField = /"ruleId":"([^"]*)"/;
const nameField = /"single":\{"(?:NAME|CALLEE)":\{"text":"((?:[^"\\]|\\.)*)"/;

function slim(line) {
  const range = rangeField.exec(line);
  const rule = ruleField.exec(line)?.[1] ?? "";
  const name = nameField.exec(line)?.[1];
  const match = {
    ruleId: rule,
    file: JSON.parse(`"${fileField.exec(line)?.[1] ?? ""}"`),
    range: {
      byteOffset: { start: Number(range?.[1] ?? 0), end: Number(range?.[2] ?? 0) },
      start: { line: Number(range?.[3] ?? 0) },
    },
    metaVariables: { single: name === undefined ? {} : { NAME: { text: name }, CALLEE: { text: name } } },
    text: "",
  };
  if (rule === "reach-blocking-site") match.text = JSON.parse(line).text;
  return match;
}

function crateOf(file) {
  const at = file.indexOf("/src/");
  return at === -1 ? dirname(file) : file.slice(0, at);
}

function loadAllowed() {
  if (!existsSync(allowFile)) return new Set();
  return new Set(
    readFileSync(allowFile, "utf8")
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  );
}

function buildIndex(defs) {
  const byFile = new Map();
  const byCrate = new Map();
  for (const match of defs) {
    const name = match.metaVariables.single.NAME?.text;
    if (!name) continue;
    const fn = {
      name,
      file: match.file,
      line: match.range.start.line + 1,
      start: match.range.byteOffset.start,
      end: match.range.byteOffset.end,
    };
    fn.key = `${fn.file}::${name}@${fn.line}`;
    if (!byFile.has(fn.file)) byFile.set(fn.file, []);
    byFile.get(fn.file).push(fn);
    const crate = crateOf(fn.file);
    if (!byCrate.has(crate)) byCrate.set(crate, new Map());
    const names = byCrate.get(crate);
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(fn);
  }
  for (const fns of byFile.values()) fns.sort((a, b) => a.start - b.start);
  return { byFile, byCrate };
}

function enclosing(index, file, offset) {
  const fns = index.byFile.get(file);
  if (!fns) return null;
  let low = 0;
  let high = fns.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (fns[middle].start <= offset) low = middle + 1;
    else high = middle;
  }
  for (let at = low - 1; at >= 0; at -= 1) {
    if (offset < fns[at].end) return fns[at];
  }
  return null;
}

function resolveCallee(index, file, name) {
  const local = (index.byFile.get(file) ?? []).filter((fn) => fn.name === name);
  if (local.length > 0) return local;
  const crate = index.byCrate.get(crateOf(file))?.get(name) ?? [];
  return crate.length <= maxCandidates ? crate : [];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const matches = await scan(options.paths);
  const defs = matches.filter((match) => match.ruleId === "reach-fn-def");
  const calls = matches.filter((match) => match.ruleId === "reach-call-site");
  const sites = matches.filter((match) => match.ruleId === "reach-blocking-site");
  const index = buildIndex(defs);
  const edges = new Map();
  for (const call of calls) {
    const callee = call.metaVariables.single.CALLEE?.text;
    const caller = enclosing(index, call.file, call.range.byteOffset.start);
    if (!callee || !caller) continue;
    for (const target of resolveCallee(index, call.file, callee)) {
      if (target.key === caller.key) continue;
      if (!edges.has(caller.key)) edges.set(caller.key, new Map());
      edges.get(caller.key).set(target.key, { target, line: call.range.start.line + 1 });
    }
  }
  const reached = new Map();
  let frontier = [];
  for (const fns of index.byFile.values()) {
    for (const fn of fns) {
      if (rootName.test(fn.name)) {
        reached.set(fn.key, { fn, depth: 0, via: null });
        frontier.push(fn);
      }
    }
  }
  for (let depth = 1; depth <= options.depth; depth += 1) {
    const next = [];
    for (const fn of frontier) {
      for (const { target } of edges.get(fn.key)?.values() ?? []) {
        if (reached.has(target.key)) continue;
        reached.set(target.key, { fn: target, depth, via: fn.key });
        next.push(target);
      }
    }
    frontier = next;
  }
  const allowed = loadAllowed();
  const findings = [];
  for (const site of sites) {
    const fn = enclosing(index, site.file, site.range.byteOffset.start);
    const hit = fn && reached.get(fn.key);
    if (!hit || hit.depth === 0) continue;
    if (allowed.has(`${fn.file}::${fn.name}`)) continue;
    const chain = [];
    for (let step = hit; step; step = step.via ? reached.get(step.via) : null) {
      chain.unshift(`${step.fn.name} (${step.fn.file}:${step.fn.line})`);
    }
    findings.push({
      file: site.file,
      line: site.range.start.line + 1,
      call: site.text.split("\n")[0].trim(),
      function: fn.name,
      chain,
    });
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  if (options.json) {
    process.stdout.write(JSON.stringify({ findings, reached: reached.size, ms: Date.now() - started }, null, 2) + "\n");
  } else {
    for (const finding of findings) {
      process.stdout.write(
        `error[render-reaches-blocking]: ${finding.call}\n  --> ${relative(root, join(root, finding.file))}:${finding.line}\n  reached from ${finding.chain.join(" -> ")}\n\n`,
      );
    }
    process.stdout.write(
      `render reach: ${findings.length} blocking call(s) reachable from render within ${options.depth} call(s); ${reached.size} functions reached; ${Date.now() - started} ms\n`,
    );
  }
  process.exit(findings.length > 0 ? 1 : 0);
}

await main();
