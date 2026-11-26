import assert from "node:assert/strict";
import { test } from "node:test";

const blocked = () => Promise.reject(new Error("the model went away"));
globalThis.acTestNativeModules = {
  ArdiaTranslate: {
    available: true,
    userLanguages: () => ["en"],
    languageName: (identifier) => identifier,
    detect: () => Promise.resolve("de"),
    status: () => Promise.resolve("installed"),
    supportedLanguages: () => Promise.resolve(["de", "en"]),
    prepare: () => Promise.resolve(),
    translate: blocked,
    translateBlocks: blocked,
    open: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
  },
};

const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { setTelemetryRelay } = await import("../telemetry/relay.ts");
const { translatePage, setNeverTranslate, translateCrashContext } = await import("./translate.ts");
const { FakeElement, FakeText, fakePage } = await import("./fixtures/translatorPage.mjs");

test("finishing the page load mid-outage doesn't change the stage the translation failed at", async () => {
  const events = [];
  setTelemetryRelay({
    capture: (event, props) => (events.push([event, props]), true),
    log: () => {},
    resetId: async () => "",
    change: async () => true,
    installId: () => "",
  });
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "http://127.0.0.1:9/seite" });
  const tab = activeTabId(S(), w);
  const paragraph = (n) => new FakeElement("p", [new FakeText(`Absatz ${n} ist lang genug, um ganz allein zum Modell zu gehen. `.repeat(4))]);
  const page = fakePage(new FakeElement("body", [1, 2, 3, 4].map(paragraph)));
  let failedApplies = 0;
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  webviews.set(tab, {
    evaluate: async (code) => {
      const answer = page.run(code);
      if (code.includes(".apply(") && code.includes(",null]") && ++failedApplies === 3) {
        setNeverTranslate(tab, false);
        for (const until = Date.now() + 5000; Date.now() < until && translateCrashContext(tab).translate_stage !== "detect"; ) await new Promise((r) => setTimeout(r, 1));
        assert.equal(translateCrashContext(tab).translate_stage, "detect");
        await held;
      }
      return answer;
    },
  });
  const done = translatePage(tab, "en", "page_menu");
  for (const until = Date.now() + 5000; Date.now() < until && translateCrashContext(tab).translate_stage !== "detect"; ) await new Promise((r) => setTimeout(r, 1));
  release();
  await done;
  const finished = events.filter(([event]) => event === "translate_finished").map(([, props]) => props);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].outcome, "failed");
  assert.equal(finished[0].failed_stage, "model");
  assert.equal(finished[0].from, "page_menu");
  setTelemetryRelay(null);
  webviews.clear();
});
