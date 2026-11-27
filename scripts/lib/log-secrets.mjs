import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, sep } from "node:path";

const LOG_NAME = /\.(log|jsonl|txt|out|ips|crash)$|^LOG(\.old)?$|^started$/i;

export const isLogFile = (path) => LOG_NAME.test(basename(path)) || path.split(sep).includes("crashes");

export function logFiles(dirs) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isLogFile(path)) found.push(path);
    }
  };
  for (const dir of dirs) if (existsSync(dir)) walk(dir);
  return found.sort();
}

const DIGIT = (byte) => byte >= 0x30 && byte <= 0x39;

function occurs(buffer, needle, whole, width) {
  for (let at = buffer.indexOf(needle); at >= 0; at = buffer.indexOf(needle, at + 1)) {
    if (!whole) return at;
    const before = at >= width ? buffer[at - width] : -1;
    const after = at + needle.length < buffer.length ? buffer[at + needle.length] : -1;
    if (!DIGIT(before) && !DIGIT(after)) return at;
  }
  return -1;
}

export function findSecrets(buffer, secrets) {
  const hits = [];
  for (const { label, value, whole = false } of secrets) {
    for (const [encoding, width] of [["utf8", 1], ["utf16le", 2]]) {
      const at = occurs(buffer, Buffer.from(value, encoding), whole, width);
      if (at >= 0) {
        hits.push({ label, at, encoding });
        break;
      }
    }
  }
  return hits;
}

export function scanLogs({ dirs, secrets, extra = {} }) {
  const files = logFiles(dirs);
  const hits = [];
  for (const file of files) for (const hit of findSecrets(readFileSync(file), secrets)) hits.push({ file, ...hit });
  for (const [name, text] of Object.entries(extra)) for (const hit of findSecrets(Buffer.from(text), secrets)) hits.push({ file: name, ...hit });
  return { files, hits };
}

export function systemLog({ since, pids, file }) {
  const stamp = new Date(since).toLocaleString("sv-SE").replace("T", " ");
  const predicate = `processID IN {${pids.map(Number).join(", ")}}`;
  const out = openSync(file, "w");
  try {
    const shown = pids.length ? spawnSync("/usr/bin/log", ["show", "--start", stamp, "--style", "compact", "--info", "--predicate", predicate], { stdio: ["ignore", out, "pipe"], timeout: 300_000 }) : { status: 0 };
    if (shown.status !== 0) throw new Error(`log show failed: ${shown.stderr || shown.error}`);
  } finally {
    closeSync(out);
  }
  return readFileSync(file);
}
