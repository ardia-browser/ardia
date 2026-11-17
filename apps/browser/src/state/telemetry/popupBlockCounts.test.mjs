import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { cleanProperties } = await import("./sanitize.ts");
const counts = await import("./popupBlockCounts.ts");
const { popupBlocked } = await import("../site/prompts.ts");
const { dismissPopoverByPress } = await import("../tabs/popoverDismiss.ts");
const { popoverOf } = await import("../tabs/pageState.ts");
const { useBrowser } = await import("../browser/store.ts");
const { ardiaCoreNativeModules } = await import("../../test-native/ardiacore.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const POPUP_KEYS = ["popups_blocked", "popup_prompts_asked", "popups_auto_handled", "popup_answers_only_once", "popup_answers_always_allow", "popup_answers_always_deny", "popup_answers_dismissed"];

function pageTab() {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://outlook.example/mail" });
  return S().windows[w].tabIds[0];
}

const blockedPopup = (id) => ({ id, url: "https://zoom.example/signin?token=SECRET-TOKEN", origin: "https://zoom.example" });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function withSavedChoice(value) {
  const module = ardiaCoreNativeModules.ArdiaSites;
  const call = module.call;
  module.call = (verb, profile, json) =>
    verb === "settings" ? Promise.resolve(JSON.stringify({ popups: { value, isDefault: false } })) : call(verb, profile, json);
  return () => (module.call = call);
}

async function sentUsageCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts");
}

const popupProps = (event) => Object.fromEntries(POPUP_KEYS.filter((key) => key in event.properties).map((key) => [key, event.properties[key]]));

test("every key is one the telemetry client keeps", () => {
  const props = Object.fromEntries(POPUP_KEYS.map((key) => [key, 1]));
  assert.deepEqual(Object.keys(cleanProperties(props)), POPUP_KEYS);
});

test("nothing is recorded or sent while sharing is off, and counts noted before consent are not sent once it is on", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  counts.takePopupBlockCounts();

  const tab = pageTab();
  popupBlocked(tab, blockedPopup(1));
  await settle();
  counts.notePopupAnswer("only_once");
  assert.deepEqual(counts.takePopupBlockCounts(), {});

  popupBlocked(pageTab(), blockedPopup(2));
  await settle();
  client.setSharing(true, "onboarding");
  const before = (await sentUsageCounts()).length;
  usage.sessionEnding();
  const sent = (await sentUsageCounts()).slice(before);
  assert.deepEqual(sent.map(popupProps), sent.map(() => ({})));
});

test("a blocked pop-up that Ardia asks about, then the answers, are sent once with usage_counts and carry no address", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const before = (await sentUsageCounts()).length;
  counts.takePopupBlockCounts();

  const tab = pageTab();
  popupBlocked(tab, blockedPopup(10));
  popupBlocked(tab, blockedPopup(11));
  popupBlocked(tab, blockedPopup(11));
  await settle();
  assert.equal(popoverOf(tab), "popups", "Ardia asked, as before");
  dismissPopoverByPress(tab);
  assert.equal(popoverOf(tab), null);

  counts.notePopupAnswer("only_once");
  counts.notePopupAnswer("always_allow");
  counts.notePopupAnswer("always_allow");
  counts.notePopupAnswer("always_deny");
  usage.sessionEnding();

  const sent = await sentUsageCounts();
  assert.equal(sent.length, before + 1);
  const event = sent.at(-1);
  assert.deepEqual(popupProps(event), {
    popups_blocked: 2,
    popup_prompts_asked: 1,
    popup_answers_only_once: 1,
    popup_answers_always_allow: 2,
    popup_answers_always_deny: 1,
    popup_answers_dismissed: 1,
  });
  for (const key of POPUP_KEYS) if (key in event.properties) assert.equal(typeof event.properties[key], "number", key);
  const text = JSON.stringify(event).toLowerCase();
  for (const secret of ["zoom", "outlook", "http", "signin", "secret-token", "example"]) assert.ok(!text.includes(secret), `the event carries "${secret}"`);

  usage.sessionEnding();
  const later = (await sentUsageCounts()).slice(before + 1);
  assert.deepEqual(later.map(popupProps), later.map(() => ({})), "a second flush does not repeat the counts");
});

test("a pop-up a saved Always Allow or Always Deny choice settles is counted as handled, not asked, and shows no prompt", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  counts.takePopupBlockCounts();

  const restore = withSavedChoice("allow");
  try {
    const tab = pageTab();
    popupBlocked(tab, blockedPopup(20));
    await settle();
    assert.ok(!popoverOf(tab), "no prompt, as before");
  } finally {
    restore();
  }
  assert.deepEqual(counts.takePopupBlockCounts(), { popups_blocked: 1, popups_auto_handled: 1 });
});

test("Copy Diagnostics gets the session's counts and the last blocked pop-up's state, with no line break, address or host", async () => {
  client.setSharing(true, "onboarding");
  const tab = pageTab();
  popupBlocked(tab, blockedPopup(30));
  await settle();
  const asked = counts.popupBlockLine();
  assert.match(asked, /^Blocked pop-ups this session: blocked \d+, asked \d+, auto handled \d+, only once \d+, always allow \d+, always deny \d+, dismissed \d+; last: asked$/);

  counts.notePopupAnswer("always_allow");
  const line = counts.popupBlockLine();
  assert.match(line, /; last: always allow$/);
  assert.ok(!line.includes("\n"));
  for (const secret of ["zoom", "http", "example", "SECRET"]) assert.ok(!line.includes(secret), `the line carries "${secret}"`);
});

test("Copy Diagnostics counts a blocked pop-up even while sharing is off, because it never leaves the Mac", () => {
  client.setSharing(false, "settings");
  const read = (line) => Number(/blocked (\d+),/.exec(line)[1]);
  const before = read(counts.popupBlockLine());
  popupBlocked(pageTab(), blockedPopup(40));
  assert.equal(read(counts.popupBlockLine()), before + 1);
  assert.deepEqual(counts.takePopupBlockCounts(), {});
});
