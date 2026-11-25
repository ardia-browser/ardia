import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(Date.now()), 0);
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { openFromPage } = await import("./openFromPage.ts");
const { notePageHandledSiteLink } = await import("./pinnedSiteLinkOutcome.ts");
const { PINNED_SITE_LINK_OUTCOMES, notePinnedSiteLink, takePinnedSiteLinkCounts } = await import("../telemetry/pinnedSiteLinkCounts.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const GMAIL = "https://mail.google.com/mail/u/0/";
const ZERO = Object.fromEntries(PINNED_SITE_LINK_OUTCOMES.map((outcome) => [`pinned_site_link_${outcome}`, 0]));
const only = (outcome) => ({ ...ZERO, [`pinned_site_link_${outcome}`]: 1 });
const sharing = (on) => {
  client.loadChoice();
  client.setSharing(on, "settings");
};
const queuedEvents = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events;

function setup({ pinned = true, peekOtherSites = true } = {}) {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  S().updateSettings({ newTabLinksOpenIn: "tab", peekLinksToOtherSites: peekOtherSites });
  const w = S().createWindow({ url: GMAIL });
  const [page] = S().windows[w].tabIds;
  if (pinned) S().pinTabs([page], true);
  const ref = (tabId) => ({ windowId: w, profileId: S().windows[w].profileId, tabId });
  return { w, page, ref };
}

const STORY = "https://www.nytimes.com/2026/11/20/story.html";
const open = (request, ref) => openFromPage({ disposition: "foreground", url: STORY, ...request }, ref);
function counted(request, pageOpts) {
  sharing(true);
  const { page, ref, w } = setup(pageOpts);
  takePinnedSiteLinkCounts();
  open(request, ref(page));
  return { counts: takePinnedSiteLinkCounts(), page, w };
}

test("a click on a link to another site from a pinned page that Chrome's new tab matched opens a Peek and counts one peek", () => {
  const { counts, page } = counted({ fromClick: true, adoptId: "ardiacore:1", linkWait: "matched" });
  assert.deepEqual(counts, only("peeks"));
  assert.ok(S().peeks[page], "the link opened as a Peek on the pinned page");
});

test("Gmail's google.com/url redirect to another site counts as a peek", () => {
  const url = `https://www.google.com/url?q=${encodeURIComponent(STORY)}&source=gmail&ust=1&usg=x`;
  const { counts, page } = counted({ url, fromClick: true, adoptId: "ardiacore:1", linkWait: "matched" });
  assert.deepEqual(counts, only("peeks"));
  assert.ok(S().peeks[page]);
});

test("a link to the pinned page's own site counts as same site", () => {
  const { counts, w } = counted({ url: `${GMAIL}#inbox/abc`, fromClick: true, adoptId: "ardiacore:1", linkWait: "matched" });
  assert.deepEqual(counts, only("same_site"));
  assert.equal(S().windows[w].tabIds.length, 2, "it opened as a tab");
});

test("a new tab with no opener view (adopt id prefix tab) counts as no opener, whether or not a click was seen", () => {
  assert.deepEqual(counted({ adoptId: "tab:1" }).counts, only("no_opener"));
  assert.deepEqual(counted({ adoptId: "tab:2", fromClick: true }).counts, only("no_opener"));
});

test("a new tab no noted click matched counts as timed out or skipped, and stays a tab", () => {
  const timedOut = counted({ adoptId: "ardiacore:2", linkWait: "timedOut" });
  assert.deepEqual(timedOut.counts, only("unmatched_timed_out"));
  assert.equal(S().peeks[timedOut.page], undefined);
  assert.equal(S().windows[timedOut.w].tabIds.length, 2);
  assert.deepEqual(counted({ adoptId: "ardiacore:3", linkWait: "skipped" }).counts, only("unmatched_skipped"));
});

test("a new tab that was not from a click and had no wait counts as not from click", () => {
  assert.deepEqual(counted({ adoptId: "ardiacore:4" }).counts, only("not_from_click"));
  assert.deepEqual(counted({ adoptId: "ardiacore:5", linkWait: "matched" }).counts, only("not_from_click"));
});

test("a page that handled a click on a link to another site itself counts once, only for a pinned page with the setting on", () => {
  sharing(true);
  const { page } = setup();
  takePinnedSiteLinkCounts();
  notePageHandledSiteLink(page);
  assert.deepEqual(takePinnedSiteLinkCounts(), only("page_handled"));
  const unpinned = setup({ pinned: false });
  notePageHandledSiteLink(unpinned.page);
  const off = setup({ peekOtherSites: false });
  notePageHandledSiteLink(off.page);
  notePageHandledSiteLink("no such tab");
  assert.deepEqual(takePinnedSiteLinkCounts(), ZERO);
});

test("nothing is counted for an unpinned page, the setting off, a non-web address, another disposition or a request with no page", () => {
  const request = { fromClick: true, adoptId: "ardiacore:1", linkWait: "matched" };
  assert.deepEqual(counted(request, { pinned: false }).counts, ZERO);
  assert.deepEqual(counted(request, { peekOtherSites: false }).counts, ZERO);
  assert.deepEqual(counted({ ...request, url: "mailto:someone@example.com" }).counts, ZERO);
  assert.deepEqual(counted({ ...request, disposition: "background" }).counts, ZERO);
  assert.deepEqual(counted({ ...request, disposition: "window" }).counts, ZERO);
  sharing(true);
  const { w, ref } = setup();
  takePinnedSiteLinkCounts();
  openFromPage({ disposition: "foreground", url: STORY, ...request }, { windowId: w, profileId: ref().profileId });
  assert.deepEqual(takePinnedSiteLinkCounts(), ZERO);
});

test("every request is counted exactly once and recording it changes nothing else about where the link opens", () => {
  sharing(true);
  const requests = [
    { fromClick: true, adoptId: "ardiacore:1", linkWait: "matched" },
    { url: GMAIL, fromClick: true, adoptId: "ardiacore:1" },
    { adoptId: "tab:1", fromClick: true, linkWait: "timedOut" },
    { adoptId: "ardiacore:2", linkWait: "timedOut" },
    { adoptId: "ardiacore:3", linkWait: "skipped", fromClick: true },
    { adoptId: "ardiacore:4" },
  ];
  for (const request of requests) {
    const { page, ref } = setup();
    takePinnedSiteLinkCounts();
    open(request, ref(page));
    const counts = Object.values(takePinnedSiteLinkCounts());
    assert.equal(counts.reduce((a, b) => a + b, 0), 1, JSON.stringify(request));
  }
});

test("an outcome that began under an earlier sharing period is not counted in the next one", () => {
  sharing(true);
  const earlier = client.consentNow();
  assert.ok(earlier);
  sharing(false);
  sharing(true);
  takePinnedSiteLinkCounts();
  notePinnedSiteLink("peeks", earlier);
  notePinnedSiteLink("peeks", null);
  assert.deepEqual(takePinnedSiteLinkCounts(), ZERO);
  notePinnedSiteLink("peeks", client.consentNow());
  assert.deepEqual(takePinnedSiteLinkCounts(), only("peeks"));
});

test("with sharing off nothing is counted, and with it on the counts reach usage_counts without any address, host or title", async () => {
  sharing(false);
  const off = setup();
  takePinnedSiteLinkCounts();
  open({ fromClick: true, adoptId: "ardiacore:1", linkWait: "matched" }, off.ref(off.page));
  notePageHandledSiteLink(off.page);
  assert.deepEqual(takePinnedSiteLinkCounts(), ZERO);

  sharing(true);
  takePinnedSiteLinkCounts();
  for (const request of [
    { fromClick: true, adoptId: "ardiacore:1", linkWait: "matched" },
    { url: GMAIL, adoptId: "ardiacore:2" },
    { adoptId: "ardiacore:3", linkWait: "timedOut" },
    { adoptId: "ardiacore:4", linkWait: "skipped" },
    { adoptId: "ardiacore:5" },
    { adoptId: "tab:6" },
  ]) {
    const { page, ref } = setup();
    open(request, ref(page));
    if (request.adoptId === "ardiacore:5") notePageHandledSiteLink(page);
  }
  usage.emitWindowUsage(client.consentNow());
  await client.saveQueueNow();
  const sent = queuedEvents().filter((e) => e.event === "usage_counts" && e.properties.pinned_site_link_peeks !== undefined);
  assert.equal(sent.length, 1);
  const { properties } = sent[0];
  assert.deepEqual(
    Object.fromEntries(Object.entries(properties).filter(([key]) => key.startsWith("pinned_site_link_"))),
    { pinned_site_link_peeks: 1, pinned_site_link_same_site: 1, pinned_site_link_unmatched_timed_out: 1, pinned_site_link_unmatched_skipped: 1, pinned_site_link_not_from_click: 1, pinned_site_link_no_opener: 1, pinned_site_link_page_handled: 1 },
  );
  assert.doesNotMatch(JSON.stringify(sent[0]), /nytimes|google|gmail|mail\./i);
});
