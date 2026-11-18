import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../../../scripts/lib/instance.mjs";

const appArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!appArg) {
  console.error("usage: node air-traffic-test.mjs <Debug Ardia.app>");
  console.error("Checks Air Traffic Control in a hidden instance: a link from another app (a real GURL Apple Event) joins the collapsed tab group its rule names and opens it, and a rule whose group is gone opens a plain tab in its profile, in a window that is already open.");
  process.exit(2);
}
const app = resolve(appArg);
const root = mkdtempSync(join(tmpdir(), "air-traffic-"));
const gurl = join(root, "gurl");
execFileSync("swiftc", ["-O", resolve(import.meta.dirname, "../../../.claude/skills/release/scripts/gurl.swift"), "-o", gurl]);
const failures = [];

function record(name, ok, detail) {
  if (!ok) failures.push(name);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
}

async function until(test, ms = 8000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if ((last = await test())?.ok) return last;
  return last;
}

const data = join(root, "data");
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "session.json"), JSON.stringify(session({
  profiles: ["Personal", "Work"],
  windows: [{ id: "w1" }, { id: "w2", profileId: "work" }],
  tabs: [{ id: "t1", url: "about:blank", windowId: "w1" }, { id: "t2", url: "https://example.com/inbox", windowId: "w2" }],
})));
writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));

const inst = await launch(app, { data, js: "live" });
const tabsAt = (url) => inst.eval(`const s = ac.store.getState();
  return Object.values(s.tabs).filter((t) => (t.url || t.page?.nav?.url) === ${JSON.stringify(url)})
    .map((t) => ({ id: t.id, profileId: t.profileId, windowKind: s.windows[t.windowId]?.kind,
      groups: Object.values(s.groups).filter((g) => g.tabIds.includes(t.id)).map((g) => g.id) }));`);

try {
  await sleep(1500);
  const group = await inst.eval(`const s = ac.store.getState(); const g = s.groupTabs(["t2"], { name: "Inbox" }); s.updateGroup(g, { collapsed: true });
    const key = ac.store.getState().groups[g].pinKey ?? g;
    ac.airTraffic.addAirTrafficRule({ enabled: true, from: null, when: { kind: "site", host: "example.org" }, profileId: "work", open: "tab", groupKey: key });
    ac.airTraffic.addAirTrafficRule({ enabled: true, from: null, when: { kind: "site", host: "example.net" }, profileId: "work", open: "tab", groupKey: "gone" });
    ac.airTraffic.addAirTrafficRule({ enabled: true, from: null, when: { kind: "site", host: "example.net" }, profileId: "default", open: "window" });
    s.activate("t1");
    return g;`);
  await sleep(1000);

  execFileSync(gurl, [String(inst.pid), "https://example.org/grouped"], { timeout: 15000 });
  const grouped = await until(async () => {
    const [tab] = await tabsAt("https://example.org/grouped");
    const expanded = await inst.eval(`return !ac.store.getState().groups[${JSON.stringify(group)}]?.collapsed;`);
    return { ok: !!tab && tab.profileId === "work" && tab.groups.includes(group) && expanded, tab, expanded };
  });
  record("a link from another app joins the rule's tab group and opens it", grouped?.ok, grouped);

  const windowsBefore = await inst.eval(`return Object.keys(ac.store.getState().windows).length;`);
  execFileSync(gurl, [String(inst.pid), "https://example.net/plain"], { timeout: 15000 });
  const plain = await until(async () => {
    const [tab] = await tabsAt("https://example.net/plain");
    const windows = await inst.eval(`return Object.keys(ac.store.getState().windows).length;`);
    return { ok: !!tab && tab.profileId === "work" && tab.groups.length === 0 && tab.windowKind === "main" && windows === windowsBefore, tab, windows, windowsBefore };
  });
  record("a rule whose tab group is gone opens a plain tab in its profile, and the next rule doesn't take the link", plain?.ok, plain);
} finally {
  await inst.quit();
  rmSync(root, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed: ${failures.join(", ")}` : "all passed");
process.exit(failures.length ? 1 : 0);
