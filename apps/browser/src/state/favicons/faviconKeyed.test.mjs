import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { useBrowser } = await import("../browser/store.ts");
const { engineProfile } = await import("../browser/model.ts");
const { useFavicons, useAppearanceDark } = await import("./favicons.ts");
const { useFavicon, useFaviconTheme } = await import("./faviconHooks.ts");

const S = () => useBrowser.getState();
const key = () => engineProfile(S(), "default");
const setIcons = (fn) =>
  useFavicons.setState((f) => {
    const icons = f.profiles[key()] ?? { pages: {}, srcs: {}, appearances: {} };
    return { ...f, profiles: { ...f.profiles, [key()]: fn(icons) } };
  });
const setPage = (page, uri) => setIcons((x) => ({ ...x, pages: { ...x.pages, [page]: uri } }));
const icon = (url, src = null) =>
  mount(() => {
    useAppearanceDark();
    return { uri: useFavicon(url, src, "default")?.uri ?? null, theme: useFaviconTheme(url, src, "default") };
  });

function countingReads() {
  const original = useFavicons.getState;
  let reads = 0;
  useFavicons.getState = () => (reads++, original());
  return { reads: () => reads, restore: () => (useFavicons.getState = original) };
}

const fresh = () => {
  S().hydrate({});
  useBrowser.setState((s) => ({ ui: { ...s.ui, appDark: false } }));
  useFavicons.setState({ profiles: {}, themes: {} });
};

test("an icon update for one page reads nothing for a Favicon on another page, even on the same host", () => {
  fresh();
  setPage("https://same.example/b", "file:///b.png");
  const b = icon("https://same.example/b");
  const elsewhere = icon("https://other.example/");
  assert.equal(b.value.uri, "file:///b.png");
  const before = { b: b.renders, elsewhere: elsewhere.renders };
  const counter = countingReads();
  try {
    setPage("https://same.example/a", "file:///a.png");
    setPage("https://other.example/news", "file:///news.png");
    assert.equal(counter.reads(), 0, "neither Favicon re-reads the store for a page it doesn't show");
  } finally {
    counter.restore();
  }
  assert.deepEqual({ b: b.renders, elsewhere: elsewhere.renders }, before);
  setPage("https://same.example/b", "file:///b2.png");
  assert.equal(b.value.uri, "file:///b2.png", "a page whose icon changes while it is shown follows it");
  b.unmount();
  elsewhere.unmount();
});

test("two tabs on one host keep their own page icons", () => {
  fresh();
  const one = icon("https://docs.example/one");
  const two = icon("https://docs.example/two");
  setPage("https://docs.example/one", "file:///one.png");
  setPage("https://docs.example/two", "file:///two.png");
  assert.equal(one.value.uri, "file:///one.png");
  assert.equal(two.value.uri, "file:///two.png");
  one.unmount();
  two.unmount();
});

test("a theme or appearance change reaches every Favicon that shows it", () => {
  fresh();
  setPage("https://a.example/", "file:///shared.png");
  setPage("https://b.example/", "file:///shared.png");
  setIcons((x) => ({ ...x, appearances: { ...x.appearances, "https://a.example/": ["file:///a-light.png", "file:///a-dark.png"], "https://b.example/": ["file:///b-light.png", "file:///b-dark.png"] } }));
  const a = icon("https://a.example/");
  const b = icon("https://b.example/");
  const c = icon("https://c.example/");
  setPage("https://c.example/", "file:///shared.png");
  useFavicons.setState((f) => ({ ...f, themes: { ...f.themes, "file:///shared.png": { kind: "template", stroke: true } } }));
  assert.equal(c.value.theme?.kind, "template", "the template theme reaches the Favicon whose page uses that image");
  assert.deepEqual([a.value.uri, b.value.uri], ["file:///a-light.png", "file:///b-light.png"]);
  useBrowser.setState((s) => ({ ui: { ...s.ui, appDark: true } }));
  assert.deepEqual([a.value.uri, b.value.uri], ["file:///a-dark.png", "file:///b-dark.png"], "every Favicon swaps with the appearance");
  useFavicons.setState((f) => ({ ...f, profiles: {} }));
  assert.deepEqual([a.value.uri, b.value.uri, c.value.uri], [null, null, null], "a cache that starts over reaches all of them");
  a.unmount();
  b.unmount();
  c.unmount();
});
