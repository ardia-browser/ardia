import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DONORS_MAX, donorsFrom, type Donor } from "../data/donors.ts";
import { AUTOCAPTURE_PRIVATE_SELECTOR, NO_CAPTURE_SELECTOR, PRIVATE_SELECTOR } from "../data/telemetry.ts";
import { liveDonors, mountLiveDonors, renderDonors, LIVE_REFRESH_MS } from "./sponsors.ts";

test("donorsFrom keeps well-formed names and tiers and drops the rest", () => {
  assert.deepEqual(
    donorsFrom({
      sponsors: [
        { name: " Ada Lovelace ", tier: "patron" },
        { name: "Bob", tier: "gold" },
        { name: 42, tier: "friend" },
        { name: "x".repeat(41), tier: "friend" },
        { name: "Eve\u202eevil", tier: "friend" },
        { name: "Line\nBreak", tier: "friend" },
        { name: "   ", tier: "friend" },
        null,
        "Mallory",
        { name: "株式会社アーディア", tier: "backer" },
      ],
    }),
    [
      { name: "Ada Lovelace", tier: "patron" },
      { name: "株式会社アーディア", tier: "backer" },
    ],
  );
  assert.equal(donorsFrom({ sponsors: Array.from({ length: DONORS_MAX + 5 }, (_, i) => ({ name: `D${i}`, tier: "friend" })) })?.length, DONORS_MAX);
});

test("donorsFrom tells an empty list from an answer that isn't a list", () => {
  assert.deepEqual(donorsFrom({ sponsors: [] }), []);
  for (const body of [null, undefined, "x", [], {}, { sponsors: "x" }, { sponsors: null }, { error: "sponsors_unavailable" }]) {
    assert.equal(donorsFrom(body), null, JSON.stringify(body));
  }
});

function fakeDom() {
  const made: { className: string; textContent: string | null }[] = [];
  const doc = {
    createElement(tag: "li") {
      assert.equal(tag, "li");
      const node = { className: "", textContent: null as string | null };
      made.push(node);
      return node;
    },
  };
  const list = { hidden: true, children: [] as unknown[], replaceChildren(...nodes: unknown[]) { this.children = nodes; } };
  const empty = { hidden: false };
  return { doc, list, empty, made };
}

test("renderDonors builds pills from text only and swaps the empty line", () => {
  const { doc, list, empty, made } = fakeDom();
  const donors: Donor[] = [
    { name: "<img src=x onerror=alert(1)>", tier: "friend" },
    { name: "Big Co", tier: "patron" },
  ];
  renderDonors(list, empty, donors, doc);
  assert.deepEqual(made, [
    { className: "name friend", textContent: "<img src=x onerror=alert(1)>" },
    { className: "name patron", textContent: "Big Co" },
  ]);
  assert.equal(list.children.length, 2);
  assert.equal(list.hidden, false);
  assert.equal(empty.hidden, true);
  renderDonors(list, empty, [], doc);
  assert.equal(list.children.length, 0);
  assert.equal(list.hidden, true);
  assert.equal(empty.hidden, false);
});

const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

test("liveDonors returns the list, an empty list after a hide, and null on any failure", async () => {
  assert.deepEqual(await liveDonors("/api/sponsors", answer(200, { sponsors: [{ name: "Ada", tier: "friend" }] })), [{ name: "Ada", tier: "friend" }]);
  assert.deepEqual(await liveDonors("/api/sponsors", answer(200, { sponsors: [] })), []);
  assert.equal(await liveDonors("/api/sponsors", answer(503, { error: "sponsors_unavailable" })), null);
  assert.equal(await liveDonors("/api/sponsors", answer(200, { sponsors: "nope" })), null);
  assert.equal(await liveDonors("/api/sponsors", async () => { throw new TypeError("offline"); }), null);
  assert.equal(await liveDonors("/api/sponsors", async () => new Response("<html>", { status: 200 })), null);
});

test("F1: the donor list is masked in replays and kept out of autocapture", () => {
  const markup = readFileSync(new URL("../components/Sponsors.astro", import.meta.url), "utf8");
  const list = markup.match(/<ul class="names"[^>]*>/)?.[0];
  assert.ok(list, "the donor list in Sponsors.astro");
  assert.match(list, /\sdata-private(\s|>)/);
  assert.match(list, /\sdata-ac-no-capture(\s|>)/);
  assert.ok(PRIVATE_SELECTOR.split(",").map((s) => s.trim()).includes("[data-private]"), "the replay recorder masks [data-private]");
  assert.ok(AUTOCAPTURE_PRIVATE_SELECTOR.split(",").map((s) => s.trim()).includes("[data-private]"), "autocapture drops text under [data-private]");
  assert.ok(NO_CAPTURE_SELECTOR.split(",").map((s) => s.trim()).includes("[data-ac-no-capture]"), "autocapture skips [data-ac-no-capture]");
  const autocapture = readFileSync(new URL("./telemetry/autocapture.ts", import.meta.url), "utf8");
  assert.match(autocapture, /const NO_CAPTURE = NO_CAPTURE_SELECTOR;/);
  assert.match(autocapture, /from "\.\/elementText"/);
  assert.doesNotMatch(autocapture, /\.textContent/, "autocapture reads text only through elementText");
  const recorder = readFileSync(new URL("./telemetry/recorder.ts", import.meta.url), "utf8");
  assert.match(recorder, /maskTextSelector: PRIVATE_SELECTOR/);
});

test("F2: the built page holds no donor names; only the live list fills it", () => {
  const markup = readFileSync(new URL("../components/Sponsors.astro", import.meta.url), "utf8");
  assert.match(markup, /<ul class="names"[^>]*\shidden><\/ul>/);
  assert.match(markup, /mountLiveDonors\(\{ page: window, list, empty, url: section\.dataset\.sponsorsUrl, doc: document \}\)/);
  const data = readFileSync(new URL("../data/sponsors.ts", import.meta.url), "utf8");
  assert.doesNotMatch(data, /fetch\(|DONORS\b|process\.env/);
});

const ticks = async (count: number) => {
  for (let tick = 0; tick < count; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const pageEvent = (type: "pagehide" | "pageshow", persisted = false) => Object.assign(new Event(type), { persisted });

test("R4-2: names are cleared on pagehide and fetched again when Back restores the page", async () => {
  const { doc, list, empty } = fakeDom();
  const page = new EventTarget();
  const answers: unknown[] = [{ sponsors: [{ name: "Alice", tier: "friend" }] }, { sponsors: [] }];
  let asked = 0;
  const fetchImpl = (async () => new Response(JSON.stringify(answers[Math.min(asked++, answers.length - 1)]), { status: 200 })) as typeof fetch;
  await mountLiveDonors({ page, list, empty, url: "/api/sponsors", doc, fetchImpl });
  assert.equal(list.children.length, 1);
  page.dispatchEvent(pageEvent("pagehide", true));
  assert.equal(list.children.length, 0, "nothing is left for the back-forward cache to keep");
  assert.equal(empty.hidden, false);
  page.dispatchEvent(pageEvent("pageshow", false));
  await ticks(5);
  assert.equal(asked, 1, "a normal pageshow doesn't fetch again");
  page.dispatchEvent(pageEvent("pageshow", true));
  for (let tick = 0; asked < 2 && tick < 50; tick++) await ticks(1);
  await ticks(5);
  assert.equal(asked, 2);
  assert.equal(list.children.length, 0, "the donor hidden meanwhile stays gone");
});

test("R4-2: an answer that lands after pagehide doesn't paint names back", async () => {
  const { doc, list, empty } = fakeDom();
  const page = new EventTarget();
  let release: (r: Response) => void = () => {};
  const fetchImpl = (() => new Promise<Response>((resolve) => (release = resolve))) as typeof fetch;
  const mounted = mountLiveDonors({ page, list, empty, url: "/api/sponsors", doc, fetchImpl });
  page.dispatchEvent(pageEvent("pagehide", true));
  release(new Response(JSON.stringify({ sponsors: [{ name: "Late", tier: "friend" }] }), { status: 200 }));
  await mounted;
  assert.equal(list.children.length, 0);
});

test("R6: an open page asks again every 10 minutes and when its tab comes back, so a later hide leaves it", async () => {
  const { doc, list, empty } = fakeDom();
  const visibility = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const page = Object.assign(new EventTarget(), {
    every: [] as Array<{ handler: () => void; ms: number }>,
    setInterval(handler: () => void, ms: number) {
      this.every.push({ handler, ms });
      return this.every.length;
    },
  });
  const answers: unknown[] = [{ sponsors: [{ name: "Alice", tier: "friend" }] }, { sponsors: [] }, { sponsors: [] }];
  let asked = 0;
  const fetchImpl = (async () => new Response(JSON.stringify(answers[Math.min(asked++, answers.length - 1)]), { status: 200 })) as typeof fetch;
  const liveDoc = Object.assign(visibility, { createElement: doc.createElement.bind(doc) });
  await mountLiveDonors({ page, list, empty, url: "/api/sponsors", doc: liveDoc, fetchImpl });
  assert.equal(list.children.length, 1);
  assert.deepEqual(page.every.map((entry) => entry.ms), [LIVE_REFRESH_MS]);
  page.every[0].handler();
  for (let tick = 0; asked < 2 && tick < 50; tick++) await ticks(1);
  await ticks(5);
  assert.equal(list.children.length, 0, "the donor hidden meanwhile leaves the open page");
  visibility.visibilityState = "hidden";
  page.every[0].handler();
  await ticks(5);
  assert.equal(asked, 2, "a hidden tab doesn't ask");
  visibility.visibilityState = "visible";
  visibility.dispatchEvent(new Event("visibilitychange"));
  for (let tick = 0; asked < 3 && tick < 50; tick++) await ticks(1);
  assert.equal(asked, 3, "coming back to the tab asks again");
});
