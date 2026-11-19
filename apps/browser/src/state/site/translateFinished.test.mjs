import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const model = {
  available: true,
  userLanguages: () => ["en"],
  languageName: (identifier) => identifier,
  detect: async () => null,
  status: async () => "installed",
  supportedLanguages: async () => [],
  prepare: async () => {},
  translate: async (_source, _target, texts) => texts,
  translateBlocks: async (_source, _target, blocks) => blocks,
  open: async () => {},
  cancel: async () => {},
};
const working = { ...model };
globalThis.__DEV__ = false;
globalThis.acTestNativeModules = { ArdiaTranslate: model };
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { useToasts } = await import("../app/toasts.ts");
const { setTelemetryRelay } = await import("../telemetry/relay.ts");
const { translatePage, releaseTranslation } = await import("./translate.ts");

const S = () => useBrowser.getState();
const sent = [];
const relay = { capture: (event, props) => void sent.push([event, props]), log: () => {}, resetId: async () => "id", change: () => {}, installId: () => "id" };
const finished = () => sent.filter(([event]) => event === "translate_finished").map(([, props]) => props);

beforeEach(() => {
  Object.assign(model, working);
  sent.length = 0;
  setTelemetryRelay(relay);
});

const EMPTY = { passages: [], more: false, gone: false, done: 0, total: 0 };
const ONE = { passages: [[1, [[10, "Bonjour"]]]], more: false, gone: false, done: 0, total: 1 };

function openTab({ sample = { lang: "fr", text: "", active: true }, start = true, batches = [ONE] } = {}) {
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://a.com/x", profileId: S().createProfile({ name: "Work" }) });
  const tabId = S().windows[windowId].tabIds[0];
  const answers = { sample: () => sample, start: () => start, next: () => batches.shift() ?? EMPTY, apply: () => true };
  webviews.set(tabId, {
    evaluate: async (script) => {
      const ops = [...script.matchAll(/ardia\.translator"\)\]\.(\w+)\(/g)];
      return answers[ops.at(-1)?.[1]]?.();
    },
  });
  return { tabId, toast: () => useToasts.getState().toasts[windowId]?.title };
}

const everyValueIsALabel = (props) => {
  for (const key of ["stage", "reason", "model_errors"]) assert.ok(props[key] === null || /^[a-z_,]+$/.test(props[key]), `${key} is a fixed label: ${props[key]}`);
};

test("a pair the Mac doesn't offer is a refused translation with its reason, and the toast is as before", async () => {
  model.status = async () => "unsupported";
  const { tabId, toast } = openTab();
  await translatePage(tabId, "en");
  assert.deepEqual(finished(), [
    { outcome: "refused", first_pass_ms: null, first_text_ms: null, passages: 0, unlinked_passages: 0, stage: "status", reason: "pair_unavailable", model_errors: null },
  ]);
  assert.equal(toast(), "Translation error (fr to en isn't available)");
});

test("no window to ask about the language download in is a failure at prepare with the reason no_window", async () => {
  model.status = async () => "supported";
  model.prepare = async () => {
    throw new Error("no window to ask in");
  };
  const { tabId, toast } = openTab();
  await translatePage(tabId, "en");
  const [event, ...more] = finished();
  assert.equal(more.length, 0);
  assert.equal(event.outcome, "failed");
  assert.equal(event.first_pass_ms, null);
  assert.equal(event.stage, "prepare");
  assert.equal(event.reason, "no_window");
  assert.equal(toast(), "Translation error (no window to ask in)");
});

test("any other download or prepare failure is reason other, and the error's text is never sent", async () => {
  model.status = async () => "supported";
  model.prepare = async () => {
    throw new Error("Couldn't reach the server for example.com/private");
  };
  const { tabId, toast } = openTab();
  await translatePage(tabId, "en");
  const [event] = finished();
  assert.deepEqual([event.outcome, event.stage, event.reason], ["failed", "prepare", "other"]);
  assert.ok(!JSON.stringify(sent).includes("example.com"));
  assert.equal(toast(), "Translation error (Couldn't reach the server for example.com/private)");
});

test("a failure of the model's own status or open is recorded at that step", async () => {
  model.status = async () => {
    throw new Error("boom");
  };
  await translatePage(openTab().tabId, "en");
  model.status = async () => "installed";
  model.open = async () => {
    throw new Error("boom");
  };
  await translatePage(openTab().tabId, "en");
  assert.deepEqual(finished().map((e) => [e.outcome, e.stage, e.reason]), [
    ["failed", "status", "other"],
    ["failed", "open", "other"],
  ]);
});

test("a page whose language can't be told, or is already the target, is refused and recorded", async () => {
  const unknown = openTab({ sample: { lang: "", text: "", active: true } });
  await translatePage(unknown.tabId, "en");
  assert.equal(unknown.toast(), "Translation error (can't tell the page's language)");
  const same = openTab({ sample: { lang: "en-GB", text: "", active: true } });
  await translatePage(same.tabId, "en");
  assert.equal(same.toast(), "Translation error (the page is already in en)");
  assert.deepEqual(finished().map((e) => [e.outcome, e.first_pass_ms, e.stage, e.reason]), [
    ["refused", null, "detect", "other"],
    ["refused", null, "same_language", "other"],
  ]);
});

test("a page that isn't ready to start is a failure at start with the reason page_not_ready", async () => {
  const { tabId, toast } = openTab({ start: false });
  await translatePage(tabId, "en");
  const [event] = finished();
  assert.deepEqual([event.outcome, event.stage, event.reason, event.passages], ["failed", "start", "page_not_ready", 0]);
  assert.equal(event.first_pass_ms, null, "the page was never asked to start");
  assert.equal(toast(), "Translation error (the page isn't ready)");
});

test("a model that answers nothing is a failed translation with the reason model_no_answer, the model's kinds of error and no text", async () => {
  model.translateBlocks = async (_s, _t, blocks) => ({ parts: blocks.map(() => null), errors: ["not_installed", "Some sentence the model wrote about Bonjour"] });
  const { tabId, toast } = openTab();
  await translatePage(tabId, "en");
  const [event, ...more] = finished();
  assert.equal(more.length, 0);
  assert.deepEqual([event.outcome, event.stage, event.reason, event.passages], ["failed", "model", "model_no_answer", 0]);
  assert.equal(typeof event.first_pass_ms, "number");
  assert.equal(event.model_errors, "not_installed,other");
  everyValueIsALabel(event);
  assert.ok(!JSON.stringify(sent).includes("Bonjour"));
  assert.equal(toast(), "Translation error (the Mac's translation model didn't answer)");
});

test("a build that answers the parts alone still translates, and its finished event has no reason", async () => {
  model.translateBlocks = async (_s, _t, blocks) => blocks.map((pieces) => pieces.map((text) => text.toUpperCase()));
  const { tabId, toast } = openTab();
  await translatePage(tabId, "en");
  releaseTranslation(tabId);
  const [event] = finished();
  assert.deepEqual([event.outcome, event.reason, event.model_errors, event.passages], ["done", null, null, 1]);
  assert.equal(toast(), "Translated to en");
});
