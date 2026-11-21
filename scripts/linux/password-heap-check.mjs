#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const USAGE = `usage: ARDIA_LOGIN_PASSWORD=<password> node scripts/linux/password-heap-check.mjs --executable <ardia> --results <dir> [--wayland] [--dark]

Types passwords into the login-password fallback dialog of a real Ardia build
and scans the browser process's memory for copies of them.
Runs under X11 (DISPLAY, xdotool and ImageMagick's import), or with --wayland
under sway (WAYLAND_DISPLAY, wtype, swaymsg and grim), as a user whose
login password is ARDIA_LOGIN_PASSWORD, where polkit can't ask (no system bus).
Use a throwaway user in a disposable container: the password is typed for real.
It saves one throwaway login in the profile so that unlocking asks.

Flows, each typing random passwords except the login password:
  cancel     type, move the caret back and type in the middle, select all and
             type over it, compose a character with the IME, Escape; with
             --wayland it also acts as the seat's input method: commits a
             password in one string, composes one a character at a time and
             commits it, and composes one it then abandons
  supersede  type, then a second request replaces the open dialog, Escape
  submit     type a wrong password, Enter, see the error, type the login
             password, Enter, and get the grant
Each flow's answer must match (cancelled, cancelled, granted). The scans:
  while typed   the typed password is in memory exactly once, as UTF-16, and
                not at all as UTF-8 (finding it at all shows the scanner works)
  composing     with --wayland, while the third composition is still open, each
                input-method password is in memory at least once as UTF-16:
                the field received it (otherwise the verdict is
                ime-not-delivered)
  after edits   in the open dialog, text that was selected and typed over or
                erased with Backspace, or composed and abandoned, is gone
  after close   once every dialog has closed, no 10-character window of any
                typed password is left, as UTF-8 or UTF-16

  --executable PATH  the packaged launcher, e.g. <package>/ardia/bin/ardia
  --results DIR      report.json, the browser log and dialog captures
  --wayland          run Ardia on Wayland and type through an input method
  --dark             run with --force-dark-mode

Exit status: 0 when nothing is found after the dialogs close, 1 when a copy
is found, 2 when the run itself fails or a flow answers wrongly. Once the
arguments are valid and the results folder exists, the script tries to write
report.json either way; its verdict is clean, copies-found, flows-wrong,
ime-not-delivered, scanner-blind, setup-failed (the profile, the input
method or Ardia didn't start) or run-failed (an error after setup). The
verdict is write-failed when browser.log can't be written (report.json then
keeps the scan's verdict as scanVerdict) or when report.json itself can't
be written (then no report exists). Missing
arguments, a missing display or an uncreatable results folder exit 2 with
this text and no report. Any failure to finish, write the results or report
exits 2, never 1.`;

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "..", "..", "apps", "linux", "scripts", "acceptance", "lib");
const run = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WINDOW = 10;
const STRIDE = 3;

function parse(argv) {
  const options = { dark: false, wayland: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--dark") options.dark = true;
    else if (arg === "--wayland") options.wayland = true;
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

function typeFromStdin(command, args, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`));
    });
    child.stdin.end(text);
  });
}

function wtypeKeys(chord) {
  const parts = chord.split("+");
  const key = parts.pop();
  const mods = parts.map((mod) => (mod === "super" ? "logo" : mod));
  return [...mods.flatMap((mod) => ["-M", mod]), "-k", key, ...mods.reverse().flatMap((mod) => ["-m", mod])];
}

function x11Desk(run, step) {
  const xdotool = (...args) => run("xdotool", args, { timeout: 20000 });
  return {
    ozone: "x11",
    env: { DISPLAY: process.env.DISPLAY },
    type: (text) => typeFromStdin("xdotool", ["type", "--delay", "40", "--file", "-"], text),
    key: (...keys) => xdotool("key", "--delay", "60", ...keys),
    async focusDialog() {
      const found = await xdotool("search", "--onlyvisible", "--name", " - Ardia$").catch(() => ({ stdout: "" }));
      const id = found.stdout.trim().split("\n").filter(Boolean)[0];
      if (!id) throw new Error("no Ardia window to type into");
      await xdotool("windowfocus", id).catch(() => {});
    },
    capture: (path) => run("import", ["-display", process.env.DISPLAY, "-window", "root", path], { timeout: 20000 }),
  };
}

function waylandDesk(run, step) {
  const swaymsg = (...args) => run("swaymsg", args, { timeout: 20000 });
  const windows = (node, found = []) => {
    if (node.pid && typeof node.name === "string" && / - Ardia$/.test(node.name)) found.push(node);
    for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) windows(child, found);
    return found;
  };
  return {
    ozone: "wayland",
    env: { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR },
    type: (text) => typeFromStdin("wtype", ["-d", "40", "-"], text),
    async key(...keys) {
      for (const chord of keys) {
        await run("wtype", wtypeKeys(chord), { timeout: 20000 });
        await pause(60);
      }
    },
    async focusDialog() {
      const tree = JSON.parse((await swaymsg("-t", "get_tree", "-r")).stdout);
      const newest = windows(tree).sort((a, b) => b.id - a.id)[0];
      if (!newest) throw new Error("no Ardia window to type into");
      await swaymsg(`[con_id=${newest.id}]`, "focus").catch((error) => step("focus failed", { error: String(error.message) }));
    },
    capture: (path) => run("grim", [path], { timeout: 20000 }),
  };
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
  if (!options.executable || !options.results || !login || !(options.wayland ? process.env.WAYLAND_DISPLAY : process.env.DISPLAY)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const ardia = await import(join(lib, "ardia.mjs"));
  const seed = await import(join(lib, "seed.mjs"));
  try {
    await mkdir(options.results, { recursive: true });
  } catch (error) {
    process.stderr.write(`can't create ${options.results}: ${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  const scratch = join(options.results, "profile");
  const report = { dark: options.dark, wayland: options.wayland, steps: [], during: null, after: null };
  const step = (name, detail = {}) => {
    report.steps.push({ name, at: new Date().toISOString(), ...detail });
    process.stderr.write(`== ${name} ${JSON.stringify(detail)}\n`);
  };
  const desk = options.wayland ? waylandDesk(run, step) : x11Desk(run, step);
  const typeFromStdin = desk.type;
  const capture = async (name) => {
    await pause(400);
    await desk.capture(join(options.results, `${name}.png`)).catch((error) => step("capture failed", { name, error: String(error.message) }));
  };
  let answerOf = async () => "unknown";
  const dialog = async () => {
    await pause(1500);
    await desk.focusDialog();
    await pause(300);
  };
  const key = desk.key;
  let inputMethod = null;
  let app = null;
  let settingUp = true;
  let status = 2;
  try {
    await seed.writeProfileSeed(scratch, { session: seed.sessionSeed({ windows: [{ id: "main", urls: [""], frame: [0, 0, 1280, 800] }] }) });
    if (options.wayland) inputMethod = await (await import(join(here, "wayland-input-method.mjs"))).WaylandInputMethod.connect();
    app = await ardia.launchArdia({
      executable: options.executable,
      scratch,
      background: false,
      ozone: desk.ozone,
      extraArgs: options.dark ? ["--force-dark-mode"] : [],
      env: { ...desk.env, ARDIA_LOGIN_PASSWORD: undefined },
      label: "heap",
      startTimeout: 90000,
    });
    const shell = await app.mainShell({ timeout: 60000 });
    const pid = await browserPid(app.child.pid);
    if (!pid) throw new Error("no browser process found");
    step("launched", { pid });
    settingUp = false;
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
    const imeCommitted = randomSecret(16);
    const imeComposed = randomSecret(14);
    const imeAbandoned = randomSecret(14);
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
    if (inputMethod) {
      report.inputMethod = await inputMethod.waitActive();
      step("input method active", report.inputMethod);
      await inputMethod.commit(imeCommitted);
      for (let end = 1; end <= imeComposed.length; end += 1) await inputMethod.preedit(imeComposed.slice(0, end));
      await capture("3b-ime-composing");
      await inputMethod.commit(imeComposed);
      for (let end = 1; end <= imeAbandoned.length; end += 1) await inputMethod.preedit(imeAbandoned.slice(0, end));
      await pause(500);
      const received = await scan(pid, needlesFor("delivered", [imeCommitted, imeComposed, imeAbandoned]).filter((needle) => needle.scope === "whole" && needle.encoding === "utf16"));
      const copiesOf = (part) => received.hits.filter((hit) => hit.part === part).reduce((sum, hit) => sum + hit.count, 0);
      report.delivered = { committed: copiesOf(0), composed: copiesOf(1), composing: copiesOf(2) };
      step("scan while composing", report.delivered);
      await inputMethod.preedit("");
      await pause(500);
      await capture("3c-ime-done");
    }
    await typeFromStdin(cancelErased);
    await key(...Array(cancelErased.length).fill("BackSpace"));
    report.edited = await scan(pid, needlesFor("edited away", inputMethod ? [cancelHead, cancelMiddle, cancelErased, imeAbandoned] : [cancelHead, cancelMiddle, cancelErased]));
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
      ...(inputMethod ? needlesFor("input method", [imeCommitted, imeComposed, imeAbandoned]) : []),
      ...needlesFor("replaced", [replaced]),
      ...needlesFor("wrong", [wrong]),
      ...needlesFor("login", [login]),
    ];
    report.after = await scan(pid, needles);
    step("scan after close", { hits: report.after.hits, scannedBytes: report.after.scannedBytes, unreadableBytes: report.after.unreadableBytes });
    const cancelled = '{"unlocked":false}';
    const imeRight = !inputMethod || report.inputMethod?.password === true;
    const imeDelivered = !inputMethod || Object.values(report.delivered).every((copies) => copies > 0);
    const flowsRight = imeRight && answers.cancel === cancelled && answers.replaced === cancelled && answers.replacing === cancelled && answers.submit === '{"unlocked":true}';
    const typedCopies = report.during.hits.filter((hit) => hit.encoding === "utf16" && hit.scope === "whole").reduce((sum, hit) => sum + hit.count, 0);
    const typedUtf8 = report.during.hits.filter((hit) => hit.encoding === "utf8" && hit.scope === "whole").reduce((sum, hit) => sum + hit.count, 0);
    report.typedCopies = { utf16: typedCopies, utf8: typedUtf8 };
    const leaked = typedCopies > 1 || typedUtf8 > 0 || report.edited.hits.length > 0 || report.after.hits.length > 0;
    report.verdict = !flowsRight ? "flows-wrong" : !imeDelivered ? "ime-not-delivered" : typedCopies === 0 ? "scanner-blind" : leaked ? "copies-found" : "clean";
    status = report.verdict === "clean" ? 0 : report.verdict === "copies-found" ? 1 : 2;
  } catch (error) {
    report.error = String(error?.stack ?? error);
    report.verdict = settingUp ? "setup-failed" : "run-failed";
    status = 2;
    process.stderr.write(`${report.error}\n`);
  } finally {
    try {
      try {
        if (app) await writeFile(join(options.results, "browser.log"), await app.logText());
      } catch (error) {
        process.stderr.write(`can't write the browser log: ${error.message}\n`);
        report.scanVerdict = report.verdict ?? null;
        report.verdict = "write-failed";
        report.writeError = String(error.message);
        status = 2;
      }
      await writeFile(join(options.results, "report.json"), JSON.stringify(report, null, 2));
    } catch (error) {
      process.stderr.write(`can't write the results: ${error.message}\n`);
      report.verdict = "write-failed";
      status = 2;
    } finally {
      inputMethod?.close();
      await ardia.closeAllApps().catch(() => {});
    }
  }
  process.stdout.write(`${report.verdict ?? "error"}\n`);
  return status;
}

process.exitCode = await main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  return 2;
});
