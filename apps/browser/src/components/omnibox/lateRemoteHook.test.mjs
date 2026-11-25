import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../../state/browser/store.ts");
const { useSuggestions } = await import("./useSuggestions.ts");

const S = () => useBrowser.getState();
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const entry = (i) => ({ url: `https://docs.example/react-${i}`, title: `React guide ${i}`, favicon: null, visits: 30 - i, lastVisit: Date.now() - 1000, visitTimes: [Date.now() - 1000] });
const keys = (result) => result.items.map((x) => (x.kind === "search" ? `${x.suggested ? "suggest" : "search"}:${x.query}` : `${x.kind}:${x.url}`));
const reply = (q, list) => ({ status: 200, body: `)]}'\n${JSON.stringify([q, list, [], [], { "google:suggesttype": list.map(() => "QUERY") }])}` });

function setup() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://start.example/" });
  useBrowser.setState((s) => ({ history: { ...s.history, "": { list: Array.from({ length: 8 }, (_, i) => entry(i)), floor: -Infinity, ready: true } } }));
  return mount(({ text }) => useSuggestions({ text, active: true, windowId: w, profileId: "default", scope: null }), { props: { text: "" } });
}

function drawnStay(seen) {
  for (let i = 1; i < seen.length; i++) {
    const [before, after] = [seen[i - 1], seen[i]];
    if (before.text !== after.text) continue;
    assert.deepEqual(after.rows.slice(0, before.rows.length), before.rows, `rows drawn for "${after.text}" moved: ${before.rows.join(", ")} → ${after.rows.join(", ")}`);
  }
}

test("rows drawn while suggestions are on their way stay where they are when they land", async () => {
  globalThis.acTestSuggest = ({ url }) => reply(new URL(url).searchParams.get("q"), ["react hooks", "react router", "react native", "react query"]);
  try {
    const h = setup();
    const seen = [];
    const note = (text) => seen.push({ text, rows: keys(h.value) });
    h.rerender({ text: "react" });
    note("react");
    await settle(400);
    note("react");
    assert.ok(seen.at(-1).rows.some((r) => r.startsWith("suggest:")), "the suggestions came in");
    drawnStay(seen);
    h.unmount();
  } finally {
    delete globalThis.acTestSuggest;
  }
});

test("after a request fails, asking for the same text again waits for its own answer before drawing the held rows", async () => {
  let fail = true;
  globalThis.acTestSuggest = ({ url }) => (fail ? { stopped: true, status: 0 } : reply(new URL(url).searchParams.get("q"), ["react hooks", "react router", "react native", "react query"]));
  try {
    const h = setup();
    h.rerender({ text: "react" });
    await settle(400);
    const exposed = keys(h.value);
    assert.ok(exposed.filter((r) => r.startsWith("page:")).length > 3, `a failed request stops the wait: ${exposed.join(", ")}`);
    fail = false;
    h.rerender({ text: "" });
    const seen = [];
    h.rerender({ text: "react" });
    seen.push({ text: "react", rows: keys(h.value) });
    await settle(400);
    seen.push({ text: "react", rows: keys(h.value) });
    assert.ok(seen.at(-1).rows.some((r) => r.startsWith("suggest:")), `the retry's suggestions came in: ${seen.at(-1).rows.join(", ")}`);
    drawnStay(seen);
    h.unmount();
  } finally {
    delete globalThis.acTestSuggest;
  }
});

test("leaving a search scope with the same text after its request failed waits for the new request's answer", async () => {
  let fail = true;
  globalThis.acTestSuggest = ({ url }) => (fail ? { stopped: true, status: 0 } : reply(new URL(url).searchParams.get("q"), ["react hooks", "react router", "react native", "react query"]));
  try {
    S().hydrate({});
    const w = S().createWindow({ url: "https://start.example/" });
    useBrowser.setState((s) => ({ history: { ...s.history, "": { list: Array.from({ length: 8 }, (_, i) => entry(i)), floor: -Infinity, ready: true } } }));
    const google = { kind: "engine", name: "Google", host: "www.google.com", url: "https://www.google.com/search?q=%s", engineId: "google" };
    const h = mount(({ text, scope }) => useSuggestions({ text, active: true, windowId: w, profileId: "default", scope }), { props: { text: "react", scope: google } });
    await settle(400);
    fail = false;
    const seen = [];
    h.rerender({ text: "react", scope: null });
    seen.push({ text: "react", rows: keys(h.value) });
    await settle(400);
    seen.push({ text: "react", rows: keys(h.value) });
    assert.ok(seen.at(-1).rows.some((r) => r.startsWith("suggest:")), `the new request's suggestions came in: ${seen.at(-1).rows.join(", ")}`);
    drawnStay(seen);
    h.unmount();
  } finally {
    delete globalThis.acTestSuggest;
  }
});
