#!/usr/bin/env node
// Drives the import window through every flow against fake browser data, never a real profile.
//
//   node apps/browser/scripts/import-flow-test.mjs <Debug Ardia.app> <scratch dir> [flow…] [--record <file>] [--compare <file>] [--keep]
//
//   <scratch dir>     home/ is a copy of packages/import/fixtures/home (the fake Chrome, Arc, Dia, Firefox, Safari… data)
//                     and data/ the instance's ARDIA_DATA_DIR; both are wiped first; Dia's fixture windows get a pinned
//                     tab in "Side project", a Dia profile with no folder on disk. Dia's Personal profile has a sidebar
//                     file (tabs.db) and Work doesn't, so dia reads one and asks the stand-in app for the other.
//                     It must be a folder Launch Services finds apps in (not under /private/tmp; ~/Library/Caches/<name>
//                     works), or the stand-in Dia isn't found and Dia's profiles without a sidebar file get no tabs
//   flow              chrome, chromeSkip, chromeBack, arc, zen, firefox, diaFilesOnly, dia, diaOpenOnly, safariDirect,
//                     safariExport, safariBadFile
//                     (default: all of them, in that order)
//   --record <file>   writes what each flow did (the steps it passed through, counts, failures, notes, extensions and
//                     what it added to the store) as JSON
//   --compare <file>  fails each flow whose record differs from the one in <file>
//   --js <location>   where the instance loads its JS (scripts/lib/instance.mjs: pinned, live, none or host:port)
//   --keep            leaves the instance running
//
// The instance is hidden, reads the fake home through ARDIA_INSTANCE importSourceDir/importSafariHome, decrypts with
// ARDIA_TEST importSecret (the fixtures' Safe Storage secret, so the Keychain is never asked), and takes Dia's open
// tabs from packages/import/fixtures/dia through ARDIA_TEST importDiaWindows, asked of <scratch dir>/FakeDia.app (a
// background-only stand-in registered with Launch Services for the run), so the real Dia is never opened. Every flow
// opens a fresh import window and drives it through globalThis.acImport. Exit code 1 if any check failed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const recordTo = flag("--record");
const compareWith = flag("--compare");
const jsLocation = flag("--js");
const positional = args.filter((a, i) => !a.startsWith("--") && !["--record", "--compare", "--js"].includes(args[i - 1]));
const [appArg, scratchArg, ...only] = positional;
if (args.includes("-h") || args.includes("--help") || !appArg || !scratchArg) {
  const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(args.includes("-h") || args.includes("--help") ? 0 : 64);
}

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/import/fixtures");
const SECRET = JSON.parse(readFileSync(join(FIXTURES, "secrets.json"), "utf8")).chromiumSafeStorageSecret;
const scratch = resolve(scratchArg);
const home = join(scratch, "home");
const data = join(scratch, "data");
const exportsDir = join(scratch, "exports");
for (const dir of [home, data, exportsDir]) rmSync(dir, { recursive: true, force: true });
mkdirSync(exportsDir, { recursive: true });
cpSync(join(FIXTURES, "home"), home, { recursive: true });
cpSync(join(FIXTURES, "safari/Safari Export.zip"), join(exportsDir, "Safari Export.zip"));
cpSync(join(FIXTURES, "safari/not-an-export.zip"), join(exportsDir, "not-an-export.zip"));
const diaWindows = JSON.parse(readFileSync(join(FIXTURES, "dia/applescript-windows.json"), "utf8"));
for (const window of diaWindows)
  for (const profile of window.profiles)
    if (profile.name === "Side project") profile.tabs.push({ id: "t17", title: "Board", url: "https://board.example.com/", isPinned: true, isFocused: false });
const diaWindowsFile = join(exportsDir, "dia-windows.json");
writeFileSync(diaWindowsFile, JSON.stringify(diaWindows));

const FAKE_DIA_ID = "dev.ardia.fixture.dia";
const fakeDia = join(scratch, "FakeDia.app");
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
rmSync(fakeDia, { recursive: true, force: true });
mkdirSync(join(fakeDia, "Contents/MacOS"), { recursive: true });
writeFileSync(join(fakeDia, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${FAKE_DIA_ID}</string><key>CFBundleExecutable</key><string>FakeDia</string>
<key>CFBundleName</key><string>FakeDia</string><key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/>
</dict></plist>`);
writeFileSync(join(scratch, "FakeDia.swift"), `import AppKit
NSApplication.shared.setActivationPolicy(.prohibited)
DispatchQueue.main.asyncAfter(deadline: .now() + 300) { exit(0) }
NSApplication.shared.run()
`);
execFileSync("xcrun", ["swiftc", "-O", "-o", join(fakeDia, "Contents/MacOS/FakeDia"), join(scratch, "FakeDia.swift")]);
execFileSync(LSREGISTER, ["-f", fakeDia]);

const rep = reporter(join(scratch, "import-flow-test.log"), { name: "import-flow-test" });
let app = null;

const HELPERS = `
const g = () => globalThis.acImport;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = (...fns) => fns.reduce((p, f) => p.then(f), Promise.resolve());
const until = (test, ms = 30000) => new Promise((ok, no) => { const end = Date.now() + ms; const tick = () => { let v; try { v = test(); } catch {} if (v) return ok(v); if (Date.now() > end) return no(new Error("timed out: " + test)); setTimeout(tick, 40); }; tick(); });
`;
const run = (body, timeout = 90_000) => app.eval(`${HELPERS}\n${body}`, { timeout });

const storeSummary = `const s = ac.store.getState();
  const tabs = {}; for (const t of Object.values(s.tabs)) { const p = s.profiles[t.profileId]?.name ?? t.profileId; tabs[p] ??= { open: 0, pinned: 0 }; tabs[p][t.pin ? "pinned" : "open"]++; }
  const groupList = Object.values(s.groups ?? {}).map((g) => [s.profiles[g.profileId]?.name ?? g.profileId, g.name, g.pinned, s.groups[g.parentId]?.name ?? null, g.icon, g.color, g.tabIds.length].join("|")).sort();
  const icons = [...new Set(Object.values(ac.favicons.useFavicons.getState().profiles).flatMap((p) => Object.entries(p.pages).filter(([, uri]) => uri?.startsWith("data:image/png;base64,")).map(([page]) => page)))].sort();
  return { profiles: Object.values(s.profiles).map((p) => [p.name, p.color, p.icon]).sort(), tabs, groups: Object.keys(s.groups ?? {}).length, groupList, icons };`;

async function openWindow() {
  await run(`return steps(
    () => g() && (g().close(), until(() => !g(), 10000)),
    () => ac.runCommand({ command: "importBrowserData", arg: null, windowId: null }),
    () => until(() => g() && g().step === "choose", 30000),
    () => true);`);
}

const startWatch = `globalThis.__importSteps = []; clearInterval(globalThis.__importWatch);
  globalThis.__importStatus = null;
  globalThis.__importWatch = setInterval(() => { const st = g()?.step; const seen = globalThis.__importSteps; if (st && seen[seen.length - 1] !== st) seen.push(st); if (st === "progress") globalThis.__importStatus = g().status; }, 15); return true;`;

const listingSummary = `((o) => o && {
  targets: o.targets.map((t) => [t.profileName, t.extensions.map((e) => e.name)]), ids: o.targets.map((t) => t.extensions.map((e) => e.id)),
  notes: o.targets.flatMap((t) => t.extensions.filter((e) => e.offInSource || e.pinnedInSource).map((e) => [e.name, e.offInSource, e.pinnedInSource])),
  leftOut: o.leftOut.map((e) => [e.name, e.reason]), storeOpened: o.storeOpened,
})`;

const outcome = `clearInterval(globalThis.__importWatch); const f = g(); const listingSummary = ${listingSummary};
  return { steps: globalThis.__importSteps, step: f.step, error: f.error, counts: f.counts, failures: f.failures, notes: f.notes, status: globalThis.__importStatus,
    extensions: { count: f.extensions.list.length, ids: f.extensions.list.map((e) => e.id).sort(), toProfile: !!f.extensions.profileId, listing: listingSummary(f.extensions.listing) } };`;

async function flowRun(body) {
  const before = await run(storeSummary);
  await run(startWatch);
  await run(`return steps(${body}).then(() => true);`, 120_000);
  const out = await run(outcome);
  const after = await run(storeSummary);
  const added = {};
  for (const [p, c] of Object.entries(after.tabs)) {
    const b = before.tabs[p] ?? { open: 0, pinned: 0 };
    if (c.open !== b.open || c.pinned !== b.pinned) added[p] = { open: c.open - b.open, pinned: c.pinned - b.pinned };
  }
  const earlier = [...before.groupList];
  const newGroups = after.groupList.filter((g) => {
    const i = earlier.indexOf(g);
    if (i === -1) return true;
    earlier.splice(i, 1);
    return false;
  });
  out.store = { newProfiles: after.profiles.filter((p) => !before.profiles.some((q) => JSON.stringify(q) === JSON.stringify(p))), tabs: added, groups: after.groups - before.groups, newGroups, icons: after.icons };
  return out;
}

const done = `() => until(() => g().step === "done", 90000), () => settle(300)`;
const pick = (id) => `() => g().select("${id}"), () => settle(200)`;
const next = `() => g().next()`;
const stepIs = (name) => `() => until(() => g().step === "${name}")`;
const throughProfiles = `() => until(() => g().step !== "choose"), () => settle(200),
    () => g().step === "profiles" && (g().next(), until(() => g().step !== "profiles"))`;
const throughProfilesAndUnlock = `() => until(() => g().step !== "choose"), () => settle(200),
    () => g().step === "profiles" && (g().next(), until(() => g().step !== "profiles")),
    () => g().step === "unlock" && g().unlock()`;

const EXT = (c) => c.repeat(32);

const FLOWS = {
  chrome: `${pick("chrome")}, ${next}, ${throughProfiles}, ${stepIs("unlock")}, () => g().unlock(), ${done}`,
  chromeSkip: `${pick("chrome")}, ${next}, ${throughProfiles}, ${stepIs("unlock")}, () => g().skipEncrypted(), ${done},
    () => g().extensions.listing?.targets.length > 0 && g().openListedExtensions(), () => settle(300)`,
  chromeBack: `${pick("chrome")}, ${next}, ${throughProfiles}, ${stepIs("unlock")}, () => g().back(), ${stepIs("choose")}, () => settle(200)`,
  arc: `${pick("arc")}, ${next}, ${throughProfilesAndUnlock}, ${done}`,
  zen: `${pick("zen")}, () => g().setKinds(g().kinds.filter((k) => k !== "passwords")), () => settle(200), ${next}, ${throughProfilesAndUnlock}, ${done}`,
  firefox: `${pick("firefox")}, () => g().setKinds(g().kinds.filter((k) => k !== "passwords")), () => settle(200), ${next}, ${throughProfilesAndUnlock}, ${done}`,
  diaFilesOnly: `${pick("dia")}, () => g().setSourceProfiles(["Default"]), () => settle(200), ${next}, ${throughProfilesAndUnlock}, ${done}`,
  dia: `${pick("dia")}, ${next}, ${throughProfilesAndUnlock}, ${done}`,
  diaOpenOnly: `${pick("dia")}, () => g().setKinds(g().kinds.filter((k) => k !== "pinnedTabs" && k !== "favorites")), () => settle(200), ${next}, ${throughProfilesAndUnlock}, ${done}`,
  safariDirect: `${pick("safari")}, ${next}, ${stepIs("safari")}, () => settle(200), () => g().importSafariDirect(), ${done}`,
  safariExport: `${pick("safari")}, ${next}, ${stepIs("safari")}, () => g().importSafari(${JSON.stringify(join(exportsDir, "Safari Export.zip"))}), ${done}`,
  safariBadFile: `${pick("safari")}, ${next}, ${stepIs("safari")}, () => g().importSafari(${JSON.stringify(join(exportsDir, "not-an-export.zip"))}),
    () => until(() => g().step === "safari" && g().error), () => settle(200)`,
};

const CHECKS = {
  chrome: (r) => {
    assert.deepEqual(r.steps.slice(-3), ["unlock", "progress", "done"]);
    assert.ok(r.counts.bookmarks > 0 && r.counts.passwords > 0, JSON.stringify(r.counts));
    const o = r.extensions.listing;
    assert.deepEqual(r.store.newProfiles, [], "the default pick imports Chrome's default profile only");
    assert.deepEqual(o.targets, [["Personal", ["Clip Saver", "Tab Notes"]]], JSON.stringify(o));
    assert.deepEqual(o.ids, [[EXT("f"), EXT("g")]]);
    assert.deepEqual(o.notes, [["Clip Saver", false, true], ["Tab Notes", true, true]]);
    assert.deepEqual(o.leftOut, [["Company SSO", "policy"], ["Dev Helper", "unpacked"], ["Old Toolbar", "manifestV2"]]);
    assert.equal(o.storeOpened, false, "nothing opens or installs by itself");
  },
  chromeSkip: (r) => {
    assert.deepEqual(r.steps.slice(-3), ["unlock", "progress", "done"]);
    assert.equal(r.counts.passwords, 0);
    assert.equal(r.counts.cookies, 0);
    const o = r.extensions.listing;
    assert.deepEqual(o.leftOut, [["Company SSO", "policy"], ["Dev Helper", "unpacked"], ["Old Toolbar", "manifestV2"]], JSON.stringify(o));
    assert.equal(o.storeOpened, o.targets.length > 0, "Open in Chrome Web Store opens the listed pages");
  },
  chromeBack: (r) => {
    assert.deepEqual(r.steps.slice(-2), ["unlock", "choose"]);
    assert.equal(r.error, null);
  },
  arc: (r) => {
    assert.equal(r.step, "done");
    assert.ok(r.store.newProfiles.length > 0, "Arc's spaces become profiles");
    assert.ok(r.store.newProfiles.some(([name, , icon]) => name === "Work" && icon === "🛠️"), `Arc's construction glyph becomes Work's icon: ${JSON.stringify(r.store.newProfiles)}`);
    const a = r.after;
    assert.deepEqual(a.rules, [
      ["contains", "meet.google.com", null, "tab"],
      ["contains", "jira.example/browse", "Work", "tab"],
      ["contains", "https://www.docs.example/", null, "littleArdia"],
      ["equals", "calendar.example", "Personal", "littleArdia"],
    ], `Arc's Air Traffic Control rules arrive in order: ${JSON.stringify(a.rules)}`);
    assert.ok(r.notes.some((n) => n.startsWith("5 Air Traffic Control rules from Arc stayed behind")), `the deleted space's rule and the unreadable ones are named: ${JSON.stringify(r.notes)}`);
    assert.deepEqual([r.counts.rules, r.counts.archived, r.counts.settings], [4, 4, 2], JSON.stringify(r.counts));
    assert.equal(a.fallback, null);
    assert.equal(a.openLinksInLittleArdia, false, "Arc's links from other apps went to the most recent space, not Little Arc");
    assert.equal(a.cleanUpMinutes, 7 * 24 * 60, "Arc's archive-after-7-days becomes the clean-up setting");
    assert.deepEqual(a.cleaned, [
      ["https://ghost.example/", "Personal", null],
      ["https://little.example/", "Personal", null],
      ["https://old-news.example/", "Personal", null],
      ["https://report.example/q3", "Work", "Report"],
    ], `Arc's archive lands in Recently Cleaned: ${JSON.stringify(a.cleaned)}`);
    assert.equal(a.icons["https://calendar.example/"], `data:image/png;base64,${ARC_ICON("T-1")}`, "Arc's own sidebar icon beats Chromium's");
    assert.equal(a.icons["https://today.example/"], `data:image/png;base64,${ARC_ICON("T-6")}`);
    assert.ok(a.icons["https://blog.example/post"]?.startsWith("data:image/png;base64,") && a.icons["https://blog.example/post"] !== `data:image/png;base64,${ARC_ICON("T-1")}`, "Chromium's Favicons fills in");
    assert.ok(!r.failures.some((f) => f.kind === "linkRules" || f.kind === "archive"), JSON.stringify(r.failures));
  },
  firefox: (r) => {
    assert.equal(r.step, "done");
    const icons = ["https://www.mozilla.example/", "https://developer.mozilla.example/docs"];
    assert.deepEqual(icons.filter((page) => !r.store.icons.includes(page)), [], `Firefox's favicons.sqlite icons arrive: ${JSON.stringify(r.store.icons)}`);
  },
  zen: (r) => {
    assert.equal(r.step, "done");
    assert.ok(r.counts.history > 0, `Zen's history comes over: ${JSON.stringify(r.counts)}`);
    const icons = ["https://chat.example/room", "https://mail.example/", "https://docs.example/a"];
    assert.deepEqual(icons.filter((page) => !r.store.icons.includes(page)), [], `Zen's session and favicons.sqlite icons arrive: ${JSON.stringify(r.store.icons)}`);
  },
  diaFilesOnly: (r) => {
    assert.equal(r.step, "done");
    assert.ok(!r.notes.some((n) => n.startsWith("Dia's tabs couldn't be brought over:")), `a profile with a sidebar file never asks Dia: ${JSON.stringify(r.notes)}`);
    assert.ok(!r.notes.some((n) => n.startsWith("Dia's sidebar file couldn't be read")), JSON.stringify(r.notes));
    assert.ok(!r.store.newProfiles.some(([name]) => name === "Side project"), JSON.stringify(r.store.newProfiles));
  },
  dia: (r) => {
    assert.equal(r.step, "done");
    assert.ok(r.counts.tabs > 0 && !r.notes.some((n) => n.startsWith("Dia's tabs couldn't be brought over:")), JSON.stringify(r));
    for (const name of ["Work", "Side project"]) assert.ok(r.store.tabs[name]?.pinned > 0, `${name} gets its pinned tabs: ${JSON.stringify(r.store.tabs)}`);
    if (recordedFirst("diaFilesOnly")) return;
    const groups = r.store.newGroups.map((g) => g.split("|"));
    const named = (name) => groups.find((g) => g[1] === name);
    assert.deepEqual(named("Reading")?.slice(2, 6), ["true", "", "📚", "blue"], JSON.stringify(groups));
    assert.deepEqual(named("Deep")?.slice(2, 4), ["true", "Reading"], JSON.stringify(groups));
    assert.deepEqual(named("Research")?.slice(2, 6), ["false", "", "🔬", "purple"], JSON.stringify(groups));
    assert.deepEqual(named("Sources")?.slice(2, 4), ["false", "Research"], JSON.stringify(groups));
    assert.ok(named("Later"), `the edit only in tabs.db-wal comes over: ${JSON.stringify(groups)}`);
    assert.equal(named("Errands")?.[0], "Side", `Dia's second space becomes a profile of its own: ${JSON.stringify(groups)}`);
  },
  diaOpenOnly: (r) => {
    assert.equal(r.step, "done");
    assert.ok(!r.store.newProfiles.some(([name]) => name === "Side project"), `a Dia profile with only pinned tabs gets no profile when only open tabs come over: ${JSON.stringify(r.store.newProfiles)}`);
    assert.ok(Object.values(r.store.tabs).every((c) => c.pinned === 0), JSON.stringify(r.store.tabs));
  },
  safariDirect: (r) => {
    assert.deepEqual(r.steps.slice(-3), ["safari", "progress", "done"]);
    assert.ok(r.counts.bookmarks > 0, JSON.stringify(r.counts));
  },
  safariExport: (r) => {
    assert.deepEqual(r.steps.slice(-3), ["safari", "progress", "done"]);
    assert.ok(r.counts.passwords > 0, JSON.stringify(r.counts));
  },
  safariBadFile: (r) => {
    assert.equal(r.step, "safari");
    assert.ok(r.error, "the bad file shows an error");
  },
};

const arcSummary = `const s = ac.store.getState(); const name = (id) => (id === null ? null : (s.profiles[id]?.name ?? id));
  const atc = ac.airTraffic.currentAirTraffic();
  const pages = (profile) => ac.favicons.useFavicons.getState().profiles[ac.favicons.cacheKey(profile)]?.pages ?? {};
  const personal = Object.values(s.profiles).find((p) => p.name === "Personal")?.id;
  return { rules: atc.rules.map((r) => [r.when.kind, r.when.text ?? r.when.pattern ?? r.when.host ?? null, name(r.profileId), r.open]), fallback: atc.fallback,
    openLinksInLittleArdia: s.settings.openLinksInLittleArdia, cleanUpMinutes: s.settings.cleanUpInactiveTabsAfterMinutes,
    cleaned: s.cleanedTabs.map((c) => [c.tab.url, name(c.tab.profileId), c.tab.customTitle]).sort(),
    icons: Object.fromEntries(["https://calendar.example/", "https://today.example/", "https://blog.example/post"].map((p) => [p, personal ? (pages(personal)[p] ?? null) : null])) };`;
const ARC_ICON = (id) => readFileSync(join(home, "Library/Application Support/Arc/SidebarItemsFaviconCache", createHash("md5").update(id).digest("hex"))).toString("base64");
const AFTER = {
  arc: () => run(arcSummary),
};

const SETUP = {
  diaFilesOnly: () => chmodSync(diaWindowsFile, 0o000),
};
const TEARDOWN = {
  diaFilesOnly: () => chmodSync(diaWindowsFile, 0o644),
};
const wanted = only.length ? only : Object.keys(FLOWS);
const recordedFirst = (flow) => wanted.indexOf(flow) !== -1 && wanted.indexOf(flow) < wanted.indexOf("dia");
const unknown = wanted.filter((f) => !FLOWS[f]);
if (unknown.length) throw new Error(`unknown flow: ${unknown.join(", ")}`);
const expected = compareWith ? JSON.parse(readFileSync(compareWith, "utf8")) : null;
const recorded = {};

try {
  app = await launch(resolve(appArg), {
    data,
    onboarded: true,
    ...(jsLocation ? { js: jsLocation } : {}),
    instance: { importSourceDir: join(home, "Library/Application Support"), importSafariHome: home },
    test: { importSecret: SECRET, importDiaBundleId: FAKE_DIA_ID, importDiaWindows: join(exportsDir, "dia-windows.json") },
    ready: { timeout: 90_000, test: "return ac.store.getState().windowOrder.length > 0" },
  });
  rep.log("pid", app.pid, "cdp", app.port, "log", app.log);
  const listed = await run(`return globalThis.expo.modules.ArdiaImport.listBrowsers().then((j) => (typeof j === "string" ? JSON.parse(j) : j).map((b) => b.id));`);
  rep.log("listed:", JSON.stringify(listed));
  for (const name of wanted) {
    await rep.check(name, async () => {
      await openWindow();
      SETUP[name]?.();
      let r;
      try {
        r = await flowRun(FLOWS[name]);
        if (AFTER[name]) r.after = await AFTER[name]();
      } finally {
        TEARDOWN[name]?.();
      }
      recorded[name] = r;
      rep.log(name, JSON.stringify(r));
      CHECKS[name](r);
      if (expected?.[name]) assert.deepEqual(r, expected[name], `${name} differs from ${compareWith}`);
    });
  }
} finally {
  if (recordTo) writeFileSync(recordTo, JSON.stringify(recorded, null, 2));
  if (app && !args.includes("--keep")) await app.quit();
  else if (app) rep.say(`kept pid ${app.pid}: scripts/agent/ac eval ${data} '<js>'`);
  spawnSync("pkill", ["-f", join(fakeDia, "Contents/MacOS/FakeDia")]);
  execFileSync(LSREGISTER, ["-u", fakeDia]);
}
await sleep(0);
process.exit(rep.summary() ? 0 : 1);
