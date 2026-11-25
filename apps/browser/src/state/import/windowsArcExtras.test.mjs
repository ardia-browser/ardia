import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { changesFallback, md5Hex, parseArcArchive, parseArcRouting } from "../../../../../packages/expo-windows/src/import/arcExtras.ts";
import { importProfile, Unlocks } from "../../../../../packages/expo-windows/src/import/importer.ts";
import { listSources } from "../../../../../packages/expo-windows/src/import/discovery.ts";
import { arcFilePath } from "../../../../../packages/expo-windows/src/import/sidebars.ts";
import { fakeHost, support } from "./fixtures/windowsHost.mjs";

const quiet = { progress() {}, cancelled: () => false };
const spaces = new Map([["S-PERSONAL", "Personal"], ["S-WORK", "Work"], ["S-UNTITLED", "Space 1"]]);
const arcFile = (name) => readFileSync(join(support, "Arc", name), "utf8");

test("Arc for Windows reads Air Traffic Control rules as the Mac does", () => {
  const routing = parseArcRouting(arcFile("StorableLinkRouting.json"), spaces);
  assert.deepEqual(routing.rules.map((r) => [r.match, r.text, r.to.kind, r.to.spaceId, r.to.spaceName]), [
    ["contains", "meet.google.com", "mostRecent", undefined, undefined],
    ["contains", "jira.example/browse", "space", "S-WORK", "Work"],
    ["contains", "https://www.docs.example/", "littleArc", undefined, undefined],
    ["equals", "calendar.example", "littleArc", "S-PERSONAL", "Personal"],
    ["contains", "gone.example", "space", "S-DELETED", undefined],
  ]);
  assert.ok(routing.rules.every((r) => r.id.startsWith("R-")));
  assert.equal(routing.skipped, 4);
  assert.deepEqual(routing.fallback, { kind: "mostRecent" });
  assert.equal(changesFallback(routing), true);
  assert.equal(changesFallback(parseArcRouting('{"rules":[],"defaultDestination":{"littleArc":{"_0":{"mostRecent":{}}}}}', spaces)), false);
  assert.throws(() => parseArcRouting("[1]", spaces));
});

test("Arc for Windows reads only the operators, components and destinations Arc writes", () => {
  const ok = { id: "R-1", destination: { space: { _0: { mostRecent: {} } } }, sourceComponents: [{ componentType: { urlMatch: { _0: { contains: {} }, _1: "a.example" } } }] };
  const read = (rule) => parseArcRouting(JSON.stringify({ rules: [rule] }), spaces);
  assert.equal(read(ok).rules.length, 1);
  const component = (urlMatch) => [{ componentType: { urlMatch } }];
  for (const bad of [
    { ...ok, id: undefined },
    { ...ok, sourceComponents: component({ _0: { startsWith: {} }, _1: "a.example" }) },
    { ...ok, sourceComponents: component({ _0: { contains: {}, matches: {} }, _1: "a.example" }) },
    { ...ok, sourceComponents: [...ok.sourceComponents, ...ok.sourceComponents] },
    { ...ok, sourceComponents: [{ componentType: { titleMatch: { _0: { contains: {} }, _1: "a" } } }] },
    { ...ok, sourceComponents: component({ _0: { contains: {} }, _1: "a".repeat(3000) }) },
    { ...ok, destination: { space: { _0: { profile: { _0: "P" } } } } },
    { ...ok, destination: { window: { _0: { mostRecent: {} } } } },
  ]) {
    const r = read(bad);
    assert.equal(r.rules.length, 0, JSON.stringify(bad));
    assert.equal(r.skipped, 1);
  }
  const many = parseArcRouting(JSON.stringify({ rules: Array(1005).fill(ok) }), spaces);
  assert.deepEqual([many.rules.length, many.skipped], [1000, 5]);
});

test("Arc's extras are read only from inside its folder and under their size caps", async () => {
  const host = fakeHost();
  await importProfile(host, new Unlocks(), "arc", "Default", ["tabs", "spaces", "favorites", "linkRules", "archive"], {}, quiet);
  const reads = host.calls.filter(([k]) => k === "readTextWithin" || k === "readBase64Within");
  assert.ok(reads.some(([, , path]) => path.endsWith("StorableLinkRouting.json")) && reads.some(([, , path]) => path.endsWith("StorableArchiveItems.json")));
  for (const [, folder, path, largest] of reads) {
    assert.ok(path.startsWith(`${folder}\\`) && folder.endsWith("TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\Local\\Arc"), `${folder} anchors ${path}`);
    assert.ok(largest <= 64 << 20, String(largest));
  }
  assert.ok(reads.filter(([k]) => k === "readBase64Within").every(([, , , largest]) => largest === 16 * 1024));
});

test("Arc for Windows offers its extras without spaces, and its routes when every rule stays behind", async () => {
  const host = fakeHost();
  const readWithin = host.readTextWithin.bind(host);
  const skippedOnly = JSON.stringify({ rules: [{ id: "R-1", destination: { window: {} }, sourceComponents: [] }], defaultDestination: { littleArc: { _0: { mostRecent: {} } } } });
  host.readTextWithin = async (folder, path, largest) =>
    path.endsWith("StorableSidebar.json") ? null : path.endsWith("StorableLinkRouting.json") ? skippedOnly : readWithin(folder, path, largest);
  const arc = (await listSources(host)).find((s) => s.id === "arc");
  const personal = arc.profiles.find((p) => p.id === "Default");
  assert.ok(personal.available.includes("linkRules") && personal.available.includes("archive"), JSON.stringify(personal.available));
  assert.ok(!personal.available.includes("spaces"));
  const result = await importProfile(host, new Unlocks(), "arc", "Default", ["linkRules"], {}, quiet);
  assert.deepEqual([result.arcRouting.rules.length, result.arcRouting.skipped], [0, 1]);
});

test("Arc for Windows reads its sidebar inside Arc's folder under the cap, and an archive it can't read fails", async () => {
  const host = fakeHost();
  await importProfile(host, new Unlocks(), "arc", "Default", ["spaces"], {}, quiet);
  const sidebarRead = host.calls.find(([k, , path]) => k === "readTextWithin" && path.endsWith("StorableSidebar.json"));
  assert.deepEqual([sidebarRead?.[1], sidebarRead?.[3]], [arcFilePath(host), 64 << 20]);
  const refusing = fakeHost();
  const readWithin = refusing.readTextWithin.bind(refusing);
  refusing.readTextWithin = async (folder, path, largest) => (path.endsWith("StorableArchiveItems.json") ? null : readWithin(folder, path, largest));
  const failed = await importProfile(refusing, new Unlocks(), "arc", "Default", ["archive"], {}, quiet);
  assert.deepEqual(failed.failed, ["archive"]);
  const absent = fakeHost();
  const list = absent.list.bind(absent);
  absent.list = async (path) => {
    const listed = await list(path);
    return Array.isArray(listed) ? listed.filter((e) => e.name !== "StorableArchiveItems.json") : listed;
  };
  const readAbsent = absent.readTextWithin.bind(absent);
  absent.readTextWithin = async (folder, path, largest) => (path.endsWith("StorableArchiveItems.json") ? null : readAbsent(folder, path, largest));
  const none = await importProfile(absent, new Unlocks(), "arc", "Default", ["archive"], {}, quiet);
  assert.deepEqual([none.failed, none.arcArchive.tabs], [[], []]);
});

test("Arc for Windows reads its archive newest first, web pages only", () => {
  const archive = parseArcArchive(arcFile("StorableArchiveItems.json"), "sevenDays", spaces);
  assert.deepEqual(archive.tabs.map((t) => [t.url, t.spaceName, t.customTitle, t.auto]), [
    ["https://ghost.example/", undefined, undefined, false],
    ["https://little.example/", undefined, undefined, false],
    ["https://report.example/q3", "Work", "Report", false],
    ["https://old-news.example/", "Personal", undefined, true],
  ]);
  assert.equal(archive.cleanUpAfterMinutes, 7 * 24 * 60);
  assert.equal(parseArcArchive(null, "never", spaces).cleanUpAfterMinutes, undefined);
  const many = Array.from({ length: 1510 }, (_, i) => ({ archivedAt: i, sidebarItem: { data: { tab: { savedURL: `https://e.example/${i}` } } } }));
  const capped = parseArcArchive(JSON.stringify({ items: many }), null, spaces);
  assert.deepEqual([capped.tabs.length, capped.dropped, capped.tabs[0].url], [1500, 10, "https://e.example/1509"]);
});

test("Arc's icon cache names match Node's MD5", () => {
  for (const id of ["", "T-1", "A".repeat(55), "A".repeat(56), "9F1B2C3D-0000-4000-8000-000000000000", "émoji 🚀"]) {
    assert.equal(md5Hex(id), createHash("md5").update(id).digest("hex"));
  }
});

test("An Arc import on Windows offers and reads the extras, and Arc's own sidebar icons come first", async () => {
  const host = fakeHost();
  assert.equal(arcFilePath(host, "x"), "C:\\Users\\tester\\AppData\\Local\\Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\Local\\Arc\\x");
  const result = await importProfile(host, new Unlocks(), "arc", "Default", ["tabs", "spaces", "pinnedTabs", "favorites", "linkRules", "archive"], {}, quiet);
  assert.deepEqual(result.failed, []);
  assert.equal(result.arcRouting.rules.length, 5);
  assert.equal(result.arcRouting.skipped, 4);
  assert.equal(result.arcArchive.tabs.length, 4);
  assert.equal(result.arcArchive.cleanUpAfterMinutes, undefined);
  const arcPng = readFileSync(join(support, "Arc/SidebarItemsFaviconCache", md5Hex("T-1"))).toString("base64");
  const byPage = new Map(result.favicons.map((f) => [f.page, f]));
  assert.equal(byPage.get("https://calendar.example/").png, arcPng);
  assert.equal(byPage.get("https://calendar.example/").icon, "https://calendar.example/icon.png");
  assert.equal(byPage.get("https://today.example/").icon, "https://today.example/favicon.ico");
  assert.ok(byPage.get("https://blog.example/post") && byPage.get("https://blog.example/post").png !== arcPng);
  assert.equal(result.arcCachedIcons, 3);
});
