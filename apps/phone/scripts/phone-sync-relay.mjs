#!/usr/bin/env node
// The phone half of a sync test for an Android phone that has no Mac. Run it where the phone is plugged in. It keeps
// the Mac's sync folder (phone-sync-mac.mjs, here or over ssh) and the phone's folder the same, both ways, over adb.
//
//   node phone-sync-relay.mjs start  --mac [HOST:]FOLDER [--serial SERIAL] [--phone-folder PATH] [--every SECONDS]
//   node phone-sync-relay.mjs sync   [--mac [HOST:]FOLDER] [--serial SERIAL] [--phone-folder PATH]
//   node phone-sync-relay.mjs status [--serial SERIAL]
//   node phone-sync-relay.mjs stop   [--serial SERIAL]
//   node phone-sync-relay.mjs type-phrase [--serial SERIAL]
//
// start remembers the options, creates the phone folder (default /sdcard/Documents/Ardia Sync) and runs a pass
// every --every seconds (default 3) in the background, logging each copy and deletion. sync runs one pass now and
// prints it; both remember the options, so later commands need only --serial, and both first write, read back, list
// and delete a probe file on the phone, so a phone that doesn't behave fails before anything is copied. status says
// whether the loop runs, its last pass and the file counts on both sides; stop ends the loop and forgets the state.
// A file changed on one side since the last pass is copied to the other; changed on both, the newer wins; gone from
// one side after a pass saw it on both, it is deleted on the other. A copy is written whole into .ardia-relay-parts
// beside the sync folder by a lone cat (adb exec-in drops anything after the command that reads stdin), then a
// separate command syncs, checks its SHA-256 and only then renames it into place, so an app never reads half a
// file; a write that lands late (the F4 read some back empty at first) is checked again for up to 2 s. A
// pass that finds a side empty after seeing files there stops without changing anything. State lives in
// $TMPDIR/ardia-phone-relay-<serial>. --adb PATH runs another adb. type-phrase reads phrase.txt beside the Mac's
// folder over ssh and types it into the phone's focused field through adb's stdin, never on a command line; on a
// phone that refuses injected text (MIUI) it says so.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMP_SUFFIX = ".relay-part";
const PARTS_FOLDER = ".ardia-relay-parts";
const PROBE_NAME = ".ardia-relay-probe";
const PROBE_TEXT = "ardia relay probe\n";

export function plan(mac, phone, record) {
  const steps = [];
  const same = (a, b) => !!a && !!b && a.mtime === b.mtime && a.size === b.size;
  for (const file of [...new Set([...Object.keys(mac), ...Object.keys(phone)])].sort()) {
    const onMac = mac[file];
    const onPhone = phone[file];
    const last = record[file];
    if (onMac && onPhone) {
      const macChanged = !last || !same(onMac, last.mac);
      const phoneChanged = !last || !same(onPhone, last.phone);
      if (!macChanged && !phoneChanged) continue;
      if (!last && onMac.size === onPhone.size && onMac.mtime === onPhone.mtime) continue;
      if (macChanged && !phoneChanged) steps.push({ kind: "toPhone", file });
      else if (phoneChanged && !macChanged) steps.push({ kind: "toMac", file });
      else steps.push({ kind: onMac.mtime >= onPhone.mtime ? "toPhone" : "toMac", file });
    } else if (onMac) {
      steps.push({ kind: last ? "deleteOnMac" : "toPhone", file });
    } else {
      steps.push({ kind: last ? "deleteOnPhone" : "toMac", file });
    }
  }
  return steps;
}

export function nextRecord(record, before, after, planned, done) {
  const copied = new Map(done.filter((s) => s.kind === "toPhone" || s.kind === "toMac").map((s) => [s.file, s.kind]));
  const finished = new Set(done.map((s) => s.file));
  const unfinished = new Set(planned.filter((s) => !finished.has(s.file)).map((s) => s.file));
  const next = {};
  for (const file of new Set([...Object.keys(before.mac), ...Object.keys(before.phone)])) {
    const kind = copied.get(file);
    if (kind === "toPhone" && after.phone[file]) next[file] = { mac: before.mac[file], phone: after.phone[file] };
    else if (kind === "toMac" && after.mac[file]) next[file] = { mac: after.mac[file], phone: before.phone[file] };
    else if (unfinished.has(file)) {
      if (record[file]) next[file] = record[file];
    } else if (!finished.has(file) && before.mac[file] && before.phone[file]) next[file] = { mac: before.mac[file], phone: before.phone[file] };
  }
  return next;
}

export const quoted = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

export function parseListing(out, { withProbe = false } = {}) {
  const files = {};
  for (const line of out.split("\n")) {
    const match = /^(\d+) (\d+) \.\/(.+)$/.exec(line.trim());
    if (!match || match[3].endsWith(TEMP_SUFFIX) || (match[3] === PROBE_NAME && !withProbe)) continue;
    files[match[3]] = { mtime: Number(match[1]), size: Number(match[2]) };
  }
  return files;
}

export const LISTED = "relay-listed";

export const LIST_STAT_SCRIPT = `if stat -c %Y . >/dev/null 2>&1; then stat -c "%Y %s %n" "$@"; else stat -f "%m %z %N" "$@"; fi 2>/dev/null; true`;

const LIST = (folder) =>
  `mkdir -p ${quoted(folder)} && cd ${quoted(folder)} && { find . -type f -exec sh -c ${quoted(LIST_STAT_SCRIPT)} sh {} + 2>/dev/null; echo ${LISTED}; }`;

export function listed(out, where, options) {
  if (!out.split("\n").some((line) => line.trim() === LISTED)) throw new Error(`the ${where} folder could not be listed`);
  return parseListing(out, options);
}

export const partsFolder = (folder) => path.posix.join(path.posix.dirname(folder), PARTS_FOLDER);

export const COMMITTED = "relay-committed";

export const COMMIT_TRIES = 9;
export const COMMIT_WAIT_MS = 250;

export const commitCommand = (part, target, sha256) =>
  `sync 2>/dev/null; h=$( (sha256sum ${quoted(part)} 2>/dev/null || shasum -a 256 ${quoted(part)}) | cut -d " " -f 1 ); ` +
  `if [ "$h" = "${sha256}" ]; then mkdir -p ${quoted(path.posix.dirname(target))} && mv -f ${quoted(part)} ${quoted(target)} && echo ${COMMITTED}; ` +
  `else echo "relay-mismatch $h $(wc -c < ${quoted(part)} 2>/dev/null || echo missing)"; fi`;

function endpoints(opts) {
  const match = /^([^/:]+):(\/.*)$/.exec(opts.mac);
  const host = match ? match[1] : null;
  const macFolder = match ? match[2] : path.resolve(opts.mac);
  const control = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlMaster=auto", "-o", `ControlPath=${path.join(opts.work, "ssh-%C")}`, "-o", "ControlPersist=120"];
  const macArgs = (command) => (host ? ["ssh", [...control, host, `sh -c ${quoted(command)}`]] : ["sh", ["-c", command]]);
  const adb = (kind, command) => [opts.adb, [...(opts.serial ? ["-s", opts.serial] : []), kind, command]];
  const sides = {
    mac: { folder: macFolder, shell: macArgs, write: (part) => macArgs(`cat > ${quoted(part)}`), read: (file) => macArgs(`cat ${quoted(file)}`) },
    phone: { folder: opts.phoneFolder, shell: (command) => adb("shell", command), write: (part) => adb("exec-in", `cat > ${quoted(part)}`), read: (file) => adb("exec-out", `cat ${quoted(file)}`) },
  };
  return { host, macFolder, macArgs, adb, sides };
}

function run([command, args], input) {
  const result = spawnSync(command, args, { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.slice(-1)[0]} failed (${result.status}): ${(result.stderr || result.stdout).trim().split("\n")[0]}`);
  return result.stdout;
}

function pipe(from, to) {
  return new Promise((resolve, reject) => {
    const reader = spawn(from[0], from[1], { stdio: ["ignore", "pipe", "pipe"] });
    const writer = spawn(to[0], to[1], { stdio: ["pipe", "pipe", "pipe"] });
    const hash = createHash("sha256");
    let bytes = 0;
    let errors = "";
    reader.stderr.on("data", (chunk) => (errors += chunk));
    writer.stderr.on("data", (chunk) => (errors += chunk));
    writer.stdout.on("data", (chunk) => (errors += chunk));
    reader.stdout.on("data", (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    reader.stdout.pipe(writer.stdin);
    writer.stdin.on("error", () => undefined);
    const codes = [];
    const done = (code) => {
      codes.push(code);
      if (codes.length < 2) return;
      if (codes.every((c) => c === 0)) resolve({ sha256: hash.digest("hex"), bytes });
      else reject(new Error(`copy failed (${codes.join(", ")}): ${errors.trim().split("\n")[0]}`));
    };
    reader.on("close", done);
    writer.on("close", done);
    reader.on("error", reject);
    writer.on("error", reject);
  });
}

let partNumber = 0;

export async function copyInto(side, from, target) {
  const parts = partsFolder(side.folder);
  const part = path.posix.join(parts, `${process.pid}-${Date.now()}-${++partNumber}${TEMP_SUFFIX}`);
  run(side.shell(`mkdir -p ${quoted(parts)}`));
  const sent = await pipe(from, side.write(part));
  let answer = "";
  for (let attempt = 1; attempt <= COMMIT_TRIES; attempt += 1) {
    answer = run(side.shell(commitCommand(part, target, sent.sha256))).trim();
    if (answer.split("\n").includes(COMMITTED)) return { ...sent, attempts: attempt };
    if (attempt < COMMIT_TRIES) await new Promise((resolve) => setTimeout(resolve, COMMIT_WAIT_MS));
  }
  run(side.shell(`rm -f ${quoted(part)}`));
  throw new Error(
    `the copy didn't arrive whole within ${((COMMIT_TRIES - 1) * COMMIT_WAIT_MS) / 1000} s, so it wasn't put in place (${sent.bytes} bytes sent, sha256 ${sent.sha256.slice(0, 12)}; the other side said ${JSON.stringify(answer)})`,
  );
}

export function emptySide(before, record) {
  const had = (side) => Object.values(record).some((entry) => entry[side]);
  if (Object.keys(before.mac).length === 0 && had("mac")) return "mac";
  if (Object.keys(before.phone).length === 0 && had("phone")) return "phone";
  return null;
}

const leftovers = (folder) =>
  `mkdir -p ${quoted(folder)} && rm -f ${quoted(path.posix.join(folder, PROBE_NAME))} && find ${quoted(folder)} -name ${quoted(`*${TEMP_SUFFIX}`)} -type f -exec rm -f {} + ; ` +
  `rm -rf ${quoted(partsFolder(folder))}; echo relay-clean`;

export async function probePhone(opts) {
  const ends = endpoints(opts);
  const phone = ends.sides.phone;
  const probe = path.posix.join(opts.phoneFolder, PROBE_NAME);
  if (!run(phone.shell(leftovers(opts.phoneFolder))).includes("relay-clean")) throw new Error("the phone didn't answer a cleanup command over adb; nothing was copied or deleted");
  let sent = null;
  let failure = null;
  try {
    sent = await copyInto(phone, [process.execPath, ["-e", `process.stdout.write(${JSON.stringify(PROBE_TEXT)})`]], probe);
  } catch (error) {
    failure = error.message;
  }
  const back = failure ? null : run(phone.read(probe));
  const listedProbe = listed(run(phone.shell(LIST(opts.phoneFolder))), "phone's", { withProbe: true })[PROBE_NAME];
  run(phone.shell(leftovers(opts.phoneFolder)));
  const stray = run(phone.shell(`find ${quoted(opts.phoneFolder)} ${quoted(partsFolder(opts.phoneFolder))} -name ${quoted(`*${TEMP_SUFFIX}`)} 2>/dev/null; true`)).trim();
  if (failure || back !== PROBE_TEXT || listedProbe?.size !== Buffer.byteLength(PROBE_TEXT) || !(listedProbe.mtime > 1_000_000_000) || stray) {
    throw new Error(
      `the phone's folder doesn't behave as expected over adb (${failure ? `write: ${failure}` : `wrote ${sent?.bytes} bytes, read back ${JSON.stringify(back)}, listed ${JSON.stringify(listedProbe)}`}${stray ? `, left behind ${stray}` : ""}); nothing was copied or deleted`,
    );
  }
}

export const PHRASE_SCRIPT = `read -r phrase; input text "$(printf '%s' "$phrase" | sed 's/ /%s/g')" && echo relay-typed`;

export function typePhrase(opts) {
  const ends = endpoints(opts);
  const phraseFile = path.posix.join(path.posix.dirname(ends.macFolder), "phrase.txt");
  const phrase = run(ends.macArgs(`cat ${quoted(phraseFile)}`)).trim();
  const words = phrase.split(/\s+/).filter(Boolean).length;
  if (words !== 24) throw new Error(`${phraseFile} holds ${words} words, not 24`);
  const typed = spawnSync(opts.adb, [...(opts.serial ? ["-s", opts.serial] : []), "shell", PHRASE_SCRIPT], { input: `${phrase}\n`, encoding: "utf8" });
  if (typed.stdout?.includes("relay-typed")) return `typed the ${words} words into the focused field (read from ${phraseFile}, never on a command line)`;
  const refused = /INJECT_EVENTS|SecurityException/.test(`${typed.stdout}${typed.stderr}`);
  throw new Error(
    refused
      ? "the phone refuses injected text (MIUI's INJECT_EVENTS): type the words by hand, or set them with your test tool's set-text action reading the file, so the phrase stays off the transcript"
      : `typing failed: ${`${typed.stderr || typed.stdout}`.trim().split("\n")[0]}`,
  );
}

export async function pass(opts) {
  const ends = endpoints(opts);
  const listMac = () => listed(run(ends.macArgs(LIST(ends.macFolder))), "Mac's");
  const listPhone = () => listed(run(ends.adb("shell", LIST(opts.phoneFolder))), "phone's");
  const recordFile = path.join(opts.work, "record.json");
  const record = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : {};
  const before = { mac: listMac(), phone: listPhone() };
  const empty = emptySide(before, record);
  if (empty) throw new Error(`the ${empty === "mac" ? "Mac's" : "phone's"} folder lists no files though the last pass saw some there; nothing was copied or deleted (check the folder, then stop and start the relay to begin again)`);
  const steps = plan(before.mac, before.phone, record);
  const done = [];
  const failed = [];
  for (const step of steps) {
    const onMac = path.posix.join(ends.macFolder, step.file);
    const onPhone = path.posix.join(opts.phoneFolder, step.file);
    try {
      if (step.kind === "toPhone") await copyInto(ends.sides.phone, ends.sides.mac.read(onMac), onPhone);
      else if (step.kind === "toMac") await copyInto(ends.sides.mac, ends.sides.phone.read(onPhone), onMac);
      else if (step.kind === "deleteOnMac") run(ends.macArgs(`rm -f ${quoted(onMac)}`));
      else run(ends.adb("shell", `rm -f ${quoted(onPhone)}`));
      done.push(step);
    } catch (error) {
      failed.push({ ...step, error: error.message });
    }
  }
  const after = { mac: listMac(), phone: listPhone() };
  fs.writeFileSync(recordFile, JSON.stringify(nextRecord(record, before, after, steps, done)));
  const summary = { at: new Date().toISOString(), mac: Object.keys(after.mac).length, phone: Object.keys(after.phone).length, steps: done, failed };
  fs.writeFileSync(path.join(opts.work, "last.json"), JSON.stringify(summary));
  return summary;
}

const stamp = () => new Date().toISOString().slice(11, 19);

function printPass(summary) {
  for (const step of summary.steps) console.log(`${stamp()} ${step.kind} ${step.file}`);
  for (const step of summary.failed) console.log(`${stamp()} FAILED ${step.kind} ${step.file}: ${step.error}`);
  return `${summary.mac} file(s) on the Mac, ${summary.phone} on the phone, ${summary.steps.length} change(s), ${summary.failed.length} failure(s)`;
}

function options(argv) {
  const found = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (name === "--mac") found.mac = value;
    else if (name === "--serial") found.serial = value;
    else if (name === "--phone-folder") found.phoneFolder = value;
    else if (name === "--every") found.every = Number(value);
    else if (name === "--adb") found.adb = value;
    else if (name === "--work") found.work = value;
    else throw new Error(`unknown option ${name}`);
    index += 1;
  }
  found.work = path.resolve(found.work ?? path.join(os.tmpdir(), `ardia-phone-relay-${found.serial ?? "default"}`));
  const savedFile = path.join(found.work, "relay.json");
  const saved = fs.existsSync(savedFile) ? JSON.parse(fs.readFileSync(savedFile, "utf8")) : {};
  const merged = { ...saved, ...Object.fromEntries(Object.entries(found).filter(([, v]) => v !== undefined)) };
  return { ...merged, every: merged.every ?? 3, adb: merged.adb ?? "adb", phoneFolder: merged.phoneFolder ?? "/sdcard/Documents/Ardia Sync" };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function loop(opts) {
  for (;;) {
    try {
      const summary = await pass(opts);
      if (summary.steps.length || summary.failed.length) console.log(`${stamp()} ${printPass(summary)}`);
    } catch (error) {
      console.log(`${stamp()} pass failed: ${error.message}`);
    }
    await new Promise((done) => setTimeout(done, opts.every * 1000));
  }
}

async function main() {
  const opts = options(process.argv.slice(2));
  const savedFile = path.join(opts.work, "relay.json");
  if (opts.command === "start") {
    if (!opts.mac) throw new Error("start needs --mac [HOST:]FOLDER");
    if (opts.pid && alive(opts.pid)) throw new Error(`a relay already runs for this phone (pid ${opts.pid}); stop it first`);
    fs.mkdirSync(opts.work, { recursive: true });
    const { command, pid, ...kept } = opts;
    fs.writeFileSync(savedFile, JSON.stringify(kept));
    await probePhone(opts);
    console.log(`${stamp()} the phone's folder answers over adb (write, read back, list, delete)`);
    console.log(`${stamp()} first pass: ${printPass(await pass(opts))}`);
    const log = path.join(opts.work, "relay.log");
    const out = fs.openSync(log, "a");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "loop", "--work", opts.work], { detached: true, stdio: ["ignore", out, out] });
    child.unref();
    fs.writeFileSync(savedFile, JSON.stringify({ ...kept, pid: child.pid }));
    console.log(`${stamp()} relay running (pid ${child.pid}) every ${opts.every} s; log ${log}`);
  } else if (opts.command === "loop") {
    await loop(opts);
  } else if (opts.command === "sync") {
    if (!opts.mac) throw new Error("sync needs --mac [HOST:]FOLDER, or a relay started for this phone");
    fs.mkdirSync(opts.work, { recursive: true });
    const { command, ...kept } = opts;
    fs.writeFileSync(savedFile, JSON.stringify(kept));
    await probePhone(opts);
    console.log(`${stamp()} ${printPass(await pass(opts))}`);
  } else if (opts.command === "type-phrase") {
    if (!opts.mac) throw new Error("type-phrase needs --mac [HOST:]FOLDER, or a relay started for this phone");
    console.log(`${stamp()} ${typePhrase(opts)}`);
  } else if (opts.command === "status") {
    console.log(`relay ${opts.pid && alive(opts.pid) ? `running (pid ${opts.pid})` : "not running"}; Mac ${opts.mac ?? "?"}, phone ${opts.serial ?? "(the only one)"} ${opts.phoneFolder}`);
    const last = path.join(opts.work, "last.json");
    if (fs.existsSync(last)) {
      const summary = JSON.parse(fs.readFileSync(last, "utf8"));
      console.log(`last pass ${summary.at}: ${summary.mac} file(s) on the Mac, ${summary.phone} on the phone, ${summary.steps.length} change(s), ${summary.failed.length} failure(s)`);
    }
    const log = path.join(opts.work, "relay.log");
    if (fs.existsSync(log)) console.log(fs.readFileSync(log, "utf8").trim().split("\n").slice(-10).join("\n"));
  } else if (opts.command === "stop") {
    if (opts.pid && alive(opts.pid)) process.kill(opts.pid, "SIGTERM");
    if (opts.mac) {
      const ends = endpoints(opts);
      for (const side of [ends.sides.phone, ends.sides.mac]) {
        try {
          run(side.shell(`rm -rf ${quoted(partsFolder(side.folder))}`));
        } catch (error) {
          console.log(`could not remove ${partsFolder(side.folder)}: ${error.message}`);
        }
      }
    }
    if (opts.mac && /^[^/:]+:\//.test(opts.mac)) spawnSync("ssh", ["-o", `ControlPath=${path.join(opts.work, "ssh-%C")}`, "-O", "exit", opts.mac.split(":")[0]], { stdio: "ignore" });
    fs.rmSync(opts.work, { recursive: true, force: true });
    console.log(`relay stopped; removed ${opts.work}`);
  } else {
    const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
    console.log(lines.filter((line) => line.startsWith("//")).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(opts.command === "--help" || opts.command === "-h" ? 0 : 64);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
