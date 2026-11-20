import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "zustand";

const { transactional } = await import("../browser/transaction.ts");
const { IDLE_LIVE } = await import("../browser/model.ts");
const { bindLiveToBrowser, liveOf, setLive } = await import("./tabLive.ts");

const held = transactional();
const store = create()(held.middleware(() => ({ tabs: {} })));
bindLiveToBrowser(store, held.afterTransactionIdempotent);

const tab = (id) => ({ id, url: `https://${id}.com/`, page: { kind: "loaded" } });
const withTab = (id) => store.setState((s) => ({ tabs: { ...s.tabs, [id]: tab(id) } }));
const withoutTab = (id) => store.setState((s) => ({ tabs: Object.fromEntries(Object.entries(s.tabs).filter(([key]) => key !== id)) }));

test("a tab added, given live state and removed while publication is held leaves no live entry", () => {
  held.transaction(() => {
    withTab("brief");
    setLive("brief", { isLoading: true, playingAudio: true });
    withoutTab("brief");
  });
  assert.equal(liveOf("brief"), IDLE_LIVE);
});

test("a tab added and given live state while held keeps it once published", () => {
  held.transaction(() => {
    withTab("kept");
    setLive("kept", { isLoading: true });
  });
  assert.equal(liveOf("kept").isLoading, true);
  held.transaction(() => {
    withTab("other");
    setLive("other", { canGoBack: true });
    withoutTab("kept");
  });
  assert.equal(liveOf("kept"), IDLE_LIVE);
  assert.equal(liveOf("other").canGoBack, true);
});

test("a tab added and given live state inside a transaction that restores the starting state leaves no live entry", () => {
  const start = store.getState();
  held.transaction(() => {
    withTab("undone");
    setLive("undone", { isLoading: true });
    store.setState(start, true);
  });
  assert.equal(store.getState(), start, "nothing was published");
  assert.equal(liveOf("undone"), IDLE_LIVE);
});
