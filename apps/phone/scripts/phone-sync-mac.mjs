#!/usr/bin/env node
// The Mac half of a sync test for an Android phone that has no Mac: a hidden Ardia for Mac on this Mac, syncing to
// a folder here. phone-sync-relay.mjs, on the machine the phone is plugged into, mirrors that folder to the phone.
//
//   node apps/phone/scripts/phone-sync-mac.mjs start  [--work DIR] [--app APP] [--metro-port PORT] [--seed PROFILE_COPY]
//   node apps/phone/scripts/phone-sync-mac.mjs status [--work DIR]
//   node apps/phone/scripts/phone-sync-mac.mjs sync   [--work DIR]
//   node apps/phone/scripts/phone-sync-mac.mjs send URL [--to DEVICE_ID] [--work DIR]
//   node apps/phone/scripts/phone-sync-mac.mjs stop   [--work DIR] [--keep]
//   node apps/phone/scripts/phone-sync-mac.mjs check  [--app APP]
//
// start launches the instance hidden (open -g -n, ARDIA_BACKGROUND=1, its own ARDIA_DATA_DIR in <work>/mac), with a
// Metro for apps/browser on --metro-port (default 8099; started by this script when none is running), turns sync on
// once against <work>/folder, writes the recovery phrase only to <work>/phrase.txt (mode 0600, never printed; the
// relay's type-phrase puts it into the phone without it passing through a command line) and prints the folder and the
// devices. --seed copies a copy of a real profile into <work>/mac first (only while <work>/mac doesn't exist yet), less
// its sync files (sync.json, the sync state, journal and snapshot, and any sync key), so the Mac starts with that profile's spaces and tabs and syncs only to <work>/folder; it refuses a
// path under Library/Application Support or Library/Containers, so it is never pointed at a live profile. status prints the devices the Mac sees (id, name, kind), each one's open tabs, and the tabs open on the
// Mac, where a tab sent from the phone arrives; sync syncs now and prints the same. send opens URL in a background
// tab on the Mac and sends it to the phone (the only device it can send to, or --to). stop quits the instance and
// the Metro it started (or hands that Metro to another phone's instance still using it), and deletes <work> unless
// --keep. The default work folder is /tmp/ardia-phone-sync-mac; the default app is the Debug build that
//   ARDIACORE_FRAMEWORK="$(packages/ardiacore/scripts/fetch-engine.sh --nearest)" \
//     XCODE_XCCONFIG_FILE="$PWD/apps/browser/macos/AdHoc.xcconfig" scripts/agent/build-app --as phone-sync-mac
// makes (sync's test hooks exist only in Debug). Never an installed app. check (and start, before it launches) refuses an
// app built before this checkout's native API (packages/shell/ios/AppModule.swift changed after the app's binary) or
// Pods behind Podfile.lock, and prints the commands that bring it up to date.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attach, isAlive, launch, listenerPids, sleep } from "../../../scripts/lib/instance.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultApp = path.join(repo, "apps/browser/build-phone-sync-mac/Build/Products/Debug/Ardia.app");

function options(argv) {
  const found = { command: argv[0], work: "/tmp/ardia-phone-sync-mac", app: defaultApp, metroPort: 8099, keep: false, rest: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (name === "--work") (found.work = path.resolve(value)), (index += 1);
    else if (name === "--app") (found.app = path.resolve(value)), (index += 1);
    else if (name === "--metro-port") (found.metroPort = Number(value)), (index += 1);
    else if (name === "--to") (found.to = value), (index += 1);
    else if (name === "--seed") (found.seed = path.resolve(value)), (index += 1);
    else if (name === "--keep") found.keep = true;
    else if (name.startsWith("--")) throw new Error(`unknown option ${name}`);
    else found.rest.push(name);
  }
  return found;
}

const printHelp = () => {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  console.log(lines.filter((line) => line.startsWith("//")).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
};

const nativeApiSource = path.join(repo, "packages/shell/ios/AppModule.swift");
const nativeApiJs = path.join(repo, "apps/browser/src/platform/nativeApi.ts");
const pods = { lock: path.join(repo, "apps/browser/macos/Podfile.lock"), manifest: path.join(repo, "apps/browser/macos/Pods/Manifest.lock") };

export function appProblems(app, files = { source: nativeApiSource, js: nativeApiJs, pods }) {
  const problems = [];
  const wanted = /export const NATIVE_API_VERSION = (\d+);/.exec(fs.readFileSync(files.js, "utf8"))?.[1];
  const declared = /Constant\("apiVersion"\)\s*\{\s*\(\)\s*->\s*Int\s+in\s+(\d+)\s*\}/.exec(fs.readFileSync(files.source, "utf8"))?.[1];
  if (!fs.existsSync(app)) return [`no app at ${app}`];
  const binaries = ["Contents/MacOS/Ardia.debug.dylib", "Contents/MacOS/Ardia"].map((name) => path.join(app, name)).filter((file) => fs.existsSync(file));
  const builtAt = Math.max(0, ...binaries.map((file) => fs.statSync(file).mtimeMs));
  const changedAt = fs.statSync(files.source).mtimeMs;
  if (builtAt < changedAt) {
    problems.push(`the app was built ${new Date(builtAt).toISOString()}, before ${path.relative(repo, files.source)} last changed (${new Date(changedAt).toISOString()}); this checkout's JS needs native API ${wanted ?? "?"} and would stop with "native API skew"`);
  }
  if (wanted && declared && wanted !== declared) problems.push(`this checkout disagrees with itself: nativeApi.ts wants ${wanted}, AppModule.swift declares ${declared}`);
  const lock = fs.existsSync(files.pods.lock) ? fs.readFileSync(files.pods.lock, "utf8") : null;
  const manifest = fs.existsSync(files.pods.manifest) ? fs.readFileSync(files.pods.manifest, "utf8") : null;
  if (lock !== null && lock !== manifest) problems.push("the Pods are behind Podfile.lock, so the build fails or links old native code");
  return problems;
}

const bringUpToDate = (problems) =>
  [
    `the Mac app can't serve this checkout's JS:`,
    ...problems.map((problem) => `  - ${problem}`),
    "bring it up to date from the repo root, then start again:",
    ...(problems.some((problem) => problem.includes("Pods")) ? ["  scripts/agent/locked pod -- sh -c 'cd apps/browser/macos && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install'"] : []),
    '  ARDIACORE_FRAMEWORK="$(packages/ardiacore/scripts/fetch-engine.sh --nearest)" XCODE_XCCONFIG_FILE="$PWD/apps/browser/macos/AdHoc.xcconfig" scripts/agent/build-app --as phone-sync-mac',
    "  git diff --stat apps/browser/macos/Ardia.xcodeproj/project.pbxproj   # pod install can re-quote MARKETING_VERSION there; if that is all it changed, write back HEAD's copy with git show HEAD:<that path> > <that path>",
  ].join("\n");

function check(opts) {
  const problems = appProblems(opts.app);
  if (problems.length > 0) throw new Error(bringUpToDate(problems));
  say(`the app at ${opts.app} is current for this checkout's native API`);
}

const say = (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const paths = (work) => ({ data: path.join(work, "mac"), folder: path.join(work, "folder"), phrase: path.join(work, "phrase.txt"), metro: path.join(work, "metro.json") });

async function ensureMetro(opts) {
  if (listenerPids(opts.metroPort).length > 0) return null;
  const log = path.join(opts.work, "metro.log");
  const out = fs.openSync(log, "a");
  const child = spawn("pnpm", ["exec", "react-native", "start", "--port", String(opts.metroPort)], { cwd: path.join(repo, "apps/browser"), detached: true, stdio: ["ignore", out, out] });
  child.unref();
  for (const end = Date.now() + 120_000; Date.now() < end; await sleep(500)) {
    if (listenerPids(opts.metroPort).length > 0) {
      const record = { pid: child.pid, port: opts.metroPort, log };
      fs.writeFileSync(paths(opts.work).metro, JSON.stringify(record));
      return record;
    }
    if (!isAlive(child.pid)) break;
  }
  throw new Error(`Metro for apps/browser did not start on :${opts.metroPort} (log: ${log})`);
}

function otherInstanceOn(port, work) {
  const lines = spawnSync("ps", ["-axo", "command"], { encoding: "utf8" }).stdout.split("\n");
  for (const line of lines) {
    const match = / --metro-proxy (\S+) (\d+)$/.exec(line.trim());
    if (match && Number(match[2]) === port && path.dirname(match[1]) !== work && fs.existsSync(match[1])) return path.dirname(match[1]);
  }
  return null;
}

function stopMetro(work) {
  const file = paths(work).metro;
  if (!fs.existsSync(file)) return "no Metro of ours";
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.rmSync(file, { force: true });
  const { pid } = record;
  if (!isAlive(pid)) return "Metro had already stopped";
  const other = otherInstanceOn(record.port, work);
  if (other) {
    fs.writeFileSync(paths(other).metro, JSON.stringify(record));
    return `Metro (pid ${pid}) left running for the instance in ${other}, which now stops it`;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
  return `Metro (pid ${pid}) stopped`;
}

const report = `
  const u = acSync.useSync.getState();
  const s = ac.store.getState();
  const profileId = Object.values(s.windows)[0]?.profileId ?? Object.keys(u.remoteTabs)[0];
  const remote = Object.values(u.remoteTabs).flat();
  return {
    enabled: acSync.doc().enabled,
    status: u.status,
    mac: acSync.doc().deviceId,
    devices: u.devices.map((d) => ({ id: d.id, name: d.name, kind: d.kind, current: d.current })),
    tabsOnDevices: remote.map((d) => ({ id: d.deviceId, name: d.name, tabs: d.tabs.map((t) => t.url) })),
    sendTargets: profileId ? acSync.menu.sendTabMenuItem({ id: "", url: "https://example.com", profileId }) : null,
    macTabs: Object.values(s.tabs).map((t) => t.url).filter(Boolean),
  };
`;

function printReport(state) {
  say(`sync ${state.enabled ? "on" : "off"}, status ${state.status}, this Mac's device id ${state.mac}`);
  for (const device of state.devices) say(`device ${device.id} ${JSON.stringify(device.name)} ${device.kind ?? ""}${device.current ? " (this Mac)" : ""}`);
  for (const device of state.tabsOnDevices) say(`tabs on ${device.id} ${JSON.stringify(device.name)}: ${device.tabs.length}${device.tabs.length ? `\n    ${device.tabs.join("\n    ")}` : ""}`);
  say(`tabs open on this Mac: ${state.macTabs.length}${state.macTabs.length ? `\n    ${state.macTabs.join("\n    ")}` : ""}`);
}

export const isSyncFile = (name) => name === "sync.json" || name.startsWith("sync-state") || name.startsWith("sync-journal") || name.startsWith("sync-snapshot") || name.startsWith("sync-key-") || name.startsWith(".sync-key-");

export function seedProfile(seed, data) {
  if (!fs.existsSync(seed)) throw new Error(`no profile copy at ${seed}`);
  if (/\/Library\/Application Support\//.test(seed) || /\/Library\/Containers\//.test(seed)) throw new Error("--seed takes a copy of a profile, never the live one");
  if (fs.existsSync(data)) {
    say(`data ${data} already exists, so --seed is not copied again`);
    return;
  }
  fs.cpSync(seed, data, { recursive: true });
  const dropped = fs.readdirSync(data).filter(isSyncFile);
  for (const name of dropped) fs.rmSync(path.join(data, name), { force: true });
  say(`seeded ${data} from ${seed}, without its sync files (${dropped.join(", ") || "none"})`);
}

async function start(opts) {
  const { data, folder, phrase } = paths(opts.work);
  if (/^\/Applications\//.test(opts.app)) throw new Error("never an installed app");
  if (!fs.existsSync(opts.app)) throw new Error(`no app at ${opts.app}: build it first (see --help)`);
  const problems = appProblems(opts.app);
  if (problems.length > 0) throw new Error(bringUpToDate(problems));
  fs.mkdirSync(folder, { recursive: true });
  if (opts.seed) seedProfile(opts.seed, data);
  try {
    attach(data);
    say(`already running for ${opts.work}`);
    return status(opts);
  } catch {}
  const metro = await ensureMetro(opts);
  say(metro ? `started Metro for apps/browser on :${metro.port} (pid ${metro.pid})` : `using the Metro already on :${opts.metroPort}`);
  const mac = await launch(opts.app, {
    metroPort: opts.metroPort,
    data,
    instance: { syncFolder: folder },
    test: { reauth: "granted" },
    ready: { timeout: 180_000, test: "return !!globalThis.acSync && Object.keys(ac.store.getState().windows).length > 0" },
  });
  say(`hidden Mac instance pid ${mac.pid}, data ${data}, log ${mac.log}`);
  if (!(await mac.eval("return acSync.doc().enabled"))) {
    const turned = await mac.eval(`return acSync.turnOnSync(${JSON.stringify(folder)})`);
    say(`sync turned on: ${JSON.stringify(turned)}`);
    const words = (await mac.eval("return acSync.native.recoveryWords()")).join(" ");
    fs.writeFileSync(phrase, `${words}\n`, { mode: 0o600 });
  }
  say(`folder ${folder}`);
  say(`recovery phrase: ${fs.readFileSync(phrase, "utf8").trim().split(/\s+/).length} words in ${phrase} (mode 0600, not printed)`);
  printReport(await mac.eval(report));
}

async function status(opts) {
  const mac = attach(paths(opts.work).data);
  const { folder } = paths(opts.work);
  const files = fs.existsSync(folder) ? fs.readdirSync(folder, { recursive: true }).filter((file) => fs.statSync(path.join(folder, file)).isFile()) : [];
  say(`hidden Mac instance pid ${mac.pid}; ${files.length} file(s) in ${folder}`);
  printReport(await mac.eval(report));
}

async function syncNow(opts) {
  const mac = attach(paths(opts.work).data);
  await mac.eval("return acSync.syncNow()", { timeout: 60_000 });
  printReport(await mac.eval(report));
}

async function send(opts) {
  const url = opts.rest[0];
  if (!url || !/^https?:\/\//.test(url)) throw new Error("send takes an http(s) URL");
  const mac = attach(paths(opts.work).data);
  const result = await mac.eval(`
    const s = ac.store.getState();
    const windowId = Object.keys(s.windows)[0];
    const tabId = s.newTab(windowId, { url: ${JSON.stringify(url)}, background: true });
    const tab = ac.store.getState().tabs[tabId];
    const item = acSync.menu.sendTabMenuItem({ ...tab, url: ${JSON.stringify(url)} });
    const targets = item ? (item.children ?? [item]).map((c) => ({ id: c.id.slice("sendTo:".length), name: c.title.replace(/^Send to /, "") })) : [];
    const phones = targets.filter((t) => ${JSON.stringify(opts.to ?? null)} === null || t.id === ${JSON.stringify(opts.to ?? null)});
    if (phones.length !== 1) return { sent: false, targets };
    acSync.menu.sendTabFromMenu("sendTo:" + phones[0].id, { ...tab, url: ${JSON.stringify(url)} });
    return { sent: true, to: phones[0], targets };
  `);
  if (!result.sent) throw new Error(`no single device to send to; the Mac can send to ${JSON.stringify(result.targets)} (pick one with --to)`);
  await mac.eval("return acSync.syncNow()", { timeout: 60_000 });
  say(`sent ${url} to ${result.to.id} ${JSON.stringify(result.to.name)}`);
}

async function stop(opts) {
  let instance = null;
  try {
    instance = attach(paths(opts.work).data);
  } catch (error) {
    say(error.gone ? "the hidden Mac instance had already quit" : `no instance in ${opts.work}`);
    if (error.gone) await error.instance.quit({ graceful: false }).catch(() => undefined);
  }
  if (instance) say(`hidden Mac instance ${JSON.stringify(await instance.quit())}`);
  say(stopMetro(opts.work));
  if (!opts.keep && fs.existsSync(opts.work)) {
    fs.rmSync(opts.work, { recursive: true, force: true });
    say(`removed ${opts.work}`);
  }
}

async function main() {
  const opts = options(process.argv.slice(2));
  const commands = { start, status, sync: syncNow, send, stop, check };
  if (!commands[opts.command]) {
    printHelp();
    process.exit(opts.command === "--help" || opts.command === "-h" ? 0 : 64);
  }
  await commands[opts.command](opts);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message?.startsWith("the Mac app can't serve") ? error.message : (error.stack ?? String(error)));
    process.exit(1);
  });
}

