#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const USAGE = `usage: ARDIA_LOGIN_PASSWORD=<password> node scripts/linux/password-heap-check.mjs --executable <ardia> --results <dir> [--dark]

Types passwords into the login-password fallback dialog of a real Ardia build
and scans the browser process's memory for copies of them.
Runs under X11 (DISPLAY, xdotool and ImageMagick's import), as a user whose
login password is ARDIA_LOGIN_PASSWORD, where polkit can't ask (no system bus).
Use a throwaway user in a disposable container: the password is typed for real.
It saves one throwaway login in the profile so that unlocking asks.

Flows, each typing random passwords except the login password:
  cancel     type, move the caret back and type in the middle, select all and
             type over it, compose a character with the IME, Escape
  supersede  type, then a second request replaces the open dialog, Escape
  submit     type a wrong password, Enter, see the error, type the login
             password, Enter, and get the grant
Each flow's answer must match (cancelled, cancelled, granted). Three scans:
  while typed   the typed password is in memory exactly once, as UTF-16, and
                not at all as UTF-8 (finding it at all shows the scanner works)
  after edits   in the open dialog, text that was selected and typed over or
                erased with Backspace is gone
  after close   once every dialog has closed, no 10-character window of any
                typed password is left, as UTF-8 or UTF-16

  --executable PATH  the packaged launcher, e.g. <package>/ardia/bin/ardia
  --results DIR      report.json, the browser log and dialog captures
  --dark             run with --force-dark-mode

Exit status: 0 when nothing is found after the dialogs close, 1 when a copy
is found, 2 when the run itself fails or a flow answers wrongly.`;

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "..", "..", "apps", "desktop", "scripts", "acceptance", "lib");
const run = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WINDOW = 10;
const STRIDE = 3;

function parse(argv) {
  const options = { dark: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--dark") options.dark = true;
    else if (arg === "--executable") options.executable = argv[++i];
    else if (arg === "--results") options.results = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function randomSecret(length) {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...randomBytes(length)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function windows(text) {
  if (text.length <= WINDOW) return [text];
  const starts = [];
  for (let start = 0; start + WINDOW <= text.length; start += STRIDE) starts.push(start);
  if (starts.at(-1) !== text.length - WINDOW) starts.push(text.length - WINDOW);
  return starts.map((start) => text.slice(start, start + WINDOW));
}

function needlesFor(secret, parts) {
  const needles = [];
  parts.forEach((text, index) => {
    for (const value of [text, ...windows(text)]) {
      const scope = value === text ? "whole" : "window";
      needles.push({ secret, part: index, scope, encoding: "utf8", bytes: Buffer.from(value, "utf8") });
      needles.push({ secret, part: index, scope, encoding: "utf16", bytes: Buffer.from(value, "utf16le") });
    }
  });
  return needles;
}

async function browserPid(rootPid) {
  const parents = new Map();
  const browsers = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const status = await readFile(`/proc/${entry}/status`, "utf8").catch(() => "");
    parents.set(Number(entry), Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0));
    const exe = await readlink(`/proc/${entry}/exe`).catch(() => "");
    const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    if (exe.endsWith("/chrome") && !cmdline.includes("--type=")) browsers.push(Number(entry));
  }
  return browsers.find((pid) => {
    for (let at = pid; at > 1; at = parents.get(at) ?? 0) if (at === rootPid) return true;
    return false;
  }) ?? null;
}

async function scan(pid, needles) {
  const maps = (await readFile(`/proc/${pid}/maps`, "utf8")).split("\n");
  const fd = openSync(`/proc/${pid}/mem`, "r");
  const chunk = Buffer.alloc(8 << 20);
  const page = 4096n;
  const longest = Math.max(...needles.map((needle) => needle.bytes.length));
  const counts = needles.map(() => 0);
  let scanned = 0;
  let unreadable = 0;
  try {
    for (const line of maps) {
      const match = /^([0-9a-f]+)-([0-9a-f]+) (\S{4})/.exec(line);
      if (!match || match[3][0] !== "r" || /\[(vvar|vvar_vclock|vsyscall)\]/.test(line)) continue;
      let at = BigInt(`0x${match[1]}`);
      const end = BigInt(`0x${match[2]}`);
      let carry = Buffer.alloc(0);
      while (at < end) {
        const want = Number(end - at < BigInt(chunk.length) ? end - at : BigInt(chunk.length));
        let read = 0;
        try {
          read = readSync(fd, chunk, 0, want, at);
        } catch {
          read = 0;
        }
        if (read <= 0) {
          unreadable += Number(page);
          at += page;
          carry = Buffer.alloc(0);
          continue;
        }
        const view = Buffer.concat([carry, chunk.subarray(0, read)]);
        needles.forEach((needle, index) => {
          for (let found = view.indexOf(needle.bytes); found !== -1; found = view.indexOf(needle.bytes, found + 1)) {
            if (found + needle.bytes.length > carry.length) counts[index] += 1;
          }
        });
        carry = Buffer.from(view.subarray(Math.max(0, view.length - (longest - 1))));
        at += BigInt(read);
        scanned += read;
      }
    }
  } finally {
    closeSync(fd);
  }
  return {
    scannedBytes: scanned,
    unreadableBytes: unreadable,
    hits: needles
      .map((needle, index) => ({ secret: needle.secret, part: needle.part, scope: needle.scope, encoding: needle.encoding, count: counts[index] }))
      .filter((hit) => hit.count > 0),
  };
}

function typeFromStdin(text) {
  return new Promise((resolve, reject) => {
    const child = spawn("xdotool", ["type", "--delay", "40", "--file", "-"], { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`xdotool type exited ${code}`));
    });
    child.stdin.end(text);
  });
}

async function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const login = process.env.ARDIA_LOGIN_PASSWORD;
  delete process.env.ARDIA_LOGIN_PASSWORD;
  if (!options.executable || !options.results || !login || !process.env.DISPLAY) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const ardia = await import(join(lib, "ardia.mjs"));
  const seed = await import(join(lib, "seed.mjs"));
  await mkdir(options.results, { recursive: true });
  const scratch = join(options.results, "profile");
  await seed.writeProfileSeed(scratch, { session: seed.sessionSeed({ windows: [{ id: "main", urls: [""], frame: [0, 0, 1280, 800] }] }) });
  const report = { dark: options.dark, steps: [], during: null, after: null };
  const step = (name, detail = {}) => {
    report.steps.push({ name, at: new Date().toISOString(), ...detail });
    process.stderr.write(`== ${name} ${JSON.stringify(detail)}\n`);
  };
  const xdotool = (...args) => run("xdotool", args, { timeout: 20000 });
  const capture = async (name) => {
    await pause(400);
    await run("import", ["-display", process.env.DISPLAY, "-window", "root", join(options.results, `${name}.png`)], { timeout: 20000 }).catch((error) =>
      step("capture failed", { name, error: String(error.message) }),
    );
  };
  let answerOf = async () => "unknown";
  const dialog = async () => {
    await pause(1500);
    const found = await xdotool("search", "--onlyvisible", "--name", " - Ardia$").catch(() => ({ stdout: "" }));
    const id = found.stdout.trim().split("\n").filter(Boolean)[0];
    if (!id) throw new Error("no Ardia window to type into");
    await xdotool("windowfocus", id).catch(() => {});
    await pause(300);
  };
  const key = (...keys) => xdotool("key", "--delay", "60", ...keys);

  const app = await ardia.launchArdia({
    executable: options.executable,
    scratch,
    background: false,
    ozone: "x11",
    extraArgs: options.dark ? ["--force-dark-mode"] : [],
    env: { DISPLAY: process.env.DISPLAY, ARDIA_LOGIN_PASSWORD: undefined },
    label: "heap",
    startTimeout: 90000,
  });
  let status = 2;
  try {
    const shell = await app.mainShell({ timeout: 60000 });
    const pid = await browserPid(app.child.pid);
    if (!pid) throw new Error("no browser process found");
    step("launched", { pid });
    const host = (method, args) =>
      shell.eval(`(() => { const host = globalThis.__ardiaHost; return host.invoke(${JSON.stringify(method)}, { args: [host.bootstrap.profileId, ...${JSON.stringify(args)}] }).then((reply) => JSON.stringify(reply ?? null), (error) => "error:" + (error && (error.code || error.message))); })()`, { timeout: 20000 });
    step("seed login", { answer: await host("ArdiaPasswords.save", ["https://heap-check.invalid", "heap-check", "not-a-typed-secret"]) });
    const unlock = (slot) => {
      return shell.eval(`(() => { const host = globalThis.__ardiaHost; globalThis.${slot} = host.invoke("ArdiaPasswords.unlock", { args: [host.bootstrap.profileId] }).then((reply) => JSON.stringify(reply), (error) => "error:" + (error && (error.code || error.message))); return true; })()`, { awaitPromise: false });
    };
    const answer = async (slot) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const value = await shell.eval(`globalThis.${slot} && globalThis.${slot}.then((v) => v)`, { timeout: 2000 }).catch(() => undefined);
        if (value !== undefined && value !== null) return value;
        await pause(250);
      }
      return "no answer";
    };
    answerOf = answer;
    const answers = {};

    const cancelHead = randomSecret(20);
    const cancelMiddle = randomSecret(12);
    const cancelOver = randomSecret(18);
    const cancelTail = randomSecret(12);
    const cancelErased = randomSecret(12);
    await unlock("__heapCancel");
    await dialog();
    await capture("1-empty");
    await typeFromStdin(cancelHead);
    await key("Left", "Left", "Left", "Left");
    await typeFromStdin(cancelMiddle);
    await capture("2-typed");
    await key("ctrl+a");
    await capture("2b-selected");
    await typeFromStdin(cancelOver);
    await key("ctrl+shift+u");
    await typeFromStdin("e9");
    await capture("3-composing");
    await key("space");
    await typeFromStdin(cancelTail);
    await typeFromStdin(cancelErased);
    await key(...Array(cancelErased.length).fill("BackSpace"));
    report.edited = await scan(pid, needlesFor("edited away", [cancelHead, cancelMiddle, cancelErased]));
    step("scan after editing", { hits: report.edited.hits, scannedBytes: report.edited.scannedBytes });
    await key("Escape");
    answers.cancel = await answer("__heapCancel");
    step("cancel", { answer: answers.cancel });

    const replaced = randomSecret(26);
    await unlock("__heapReplaced");
    await dialog();
    await typeFromStdin(replaced);
    await unlock("__heapReplacing");
    await pause(1500);
    answers.replaced = await answer("__heapReplaced");
    step("supersede", { answer: answers.replaced });
    await dialog();
    await key("Escape");
    answers.replacing = await answer("__heapReplacing");
    step("replacing cancelled", { answer: answers.replacing });

    const wrong = randomSecret(28);
    await unlock("__heapSubmit");
    await dialog();
    await typeFromStdin(wrong);
    report.during = await scan(pid, needlesFor("wrong", [wrong]));
    step("scan while typed", { hits: report.during.hits, scannedBytes: report.during.scannedBytes });
    await key("Return");
    await pause(1500);
    await dialog();
    await capture("4-wrong-password");
    await typeFromStdin(login);
    await key("Return");
    answers.submit = await answer("__heapSubmit");
    step("submit", { answer: answers.submit });

    await pause(3000);
    const needles = [
      ...needlesFor("cancel", [cancelHead, cancelMiddle, cancelOver, cancelTail, cancelErased]),
      ...needlesFor("replaced", [replaced]),
      ...needlesFor("wrong", [wrong]),
      ...needlesFor("login", [login]),
    ];
    report.after = await scan(pid, needles);
    step("scan after close", { hits: report.after.hits, scannedBytes: report.after.scannedBytes, unreadableBytes: report.after.unreadableBytes });
    const cancelled = '{"unlocked":false}';
    const flowsRight = answers.cancel === cancelled && answers.replaced === cancelled && answers.replacing === cancelled && answers.submit === '{"unlocked":true}';
    const typedCopies = report.during.hits.filter((hit) => hit.encoding === "utf16" && hit.scope === "whole").reduce((sum, hit) => sum + hit.count, 0);
    const typedUtf8 = report.during.hits.filter((hit) => hit.encoding === "utf8" && hit.scope === "whole").reduce((sum, hit) => sum + hit.count, 0);
    report.typedCopies = { utf16: typedCopies, utf8: typedUtf8 };
    const leaked = typedCopies > 1 || typedUtf8 > 0 || report.edited.hits.length > 0 || report.after.hits.length > 0;
    report.verdict = !flowsRight ? "flows-wrong" : typedCopies === 0 ? "scanner-blind" : leaked ? "copies-found" : "clean";
    status = report.verdict === "clean" ? 0 : report.verdict === "copies-found" ? 1 : 2;
  } catch (error) {
    report.error = String(error?.stack ?? error);
    process.stderr.write(`${report.error}\n`);
  } finally {
    await writeFile(join(options.results, "report.json"), JSON.stringify(report, null, 2));
    await writeFile(join(options.results, "browser.log"), await app.logText());
    await ardia.closeAllApps().catch(() => {});
  }
  process.stdout.write(`${report.verdict ?? "error"}\n`);
  return status;
}

process.exitCode = await main();
