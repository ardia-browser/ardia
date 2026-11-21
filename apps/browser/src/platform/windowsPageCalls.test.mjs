import assert from "node:assert/strict";
import { test } from "node:test";
import { enginePageCalls, NOT_ON_WINDOWS_YET } from "../../../../packages/expo-windows/src/engine/pageCalls.ts";
import { missingOnWindows } from "../../../../packages/expo-windows/src/missing.ts";
const { webViewHandle } = await import("../../../../packages/ardiacore/src/WebView.tsx");

function host(answers = {}) {
  const received = [];
  const call = async (key, method, args) => {
    received.push([key, method, args]);
    const answer = answers[method];
    if (answer instanceof Error) throw answer;
    return answer ?? { ok: true };
  };
  return { call, received };
}

const engineError = (message) => Object.assign(new Error(message), { code: "ERR_ENGINE" });

test("each call sends the engine every argument by name, an absent one as null, as the host's tab calls read them", async () => {
  const { call, received } = host();
  const page = enginePageCalls(call, "page-a");
  await page.loadUrl("https://example.com/");
  await page.showDevTools();
  await page.openBlockedPopup("p1", true);
  await page.find("word", true, false);
  await page.mediaCommand("seekTo", 20);
  await page.discard(false);
  assert.deepEqual(received, [
    ["page-a", "loadUrl", { url: "https://example.com/", userInitiated: null }],
    ["page-a", "showDevTools", { panel: null }],
    ["page-a", "openBlockedPopup", { id: "p1", always: true }],
    ["page-a", "find", { text: "word", forward: true, findNext: false }],
    ["page-a", "mediaCommand", { action: "seekTo", seconds: 20 }],
    ["page-a", "discard", { unload: false }],
  ]);
});

test("the engine's replies are unwrapped into what the shared page view returns, and a closed page's empty reply into the Mac's empty answer", async () => {
  const replies = {
    evaluate: { result: "[1,2]" },
    navigationEntries: { entries: [{ url: "https://a.test/", title: "A", current: true }] },
    pageCookies: { cookies: [{ name: "n" }] },
    sleepIfHidden: { keptBy: [101] },
    discard: { outcome: "discarded" },
  };
  const full = enginePageCalls(host(replies).call, "page-b");
  assert.equal(await full.evaluate("1"), "[1,2]");
  assert.deepEqual(await full.navigationEntries(), replies.navigationEntries.entries);
  assert.deepEqual(await full.pageCookies(["https://a.test/"]), [{ name: "n" }]);
  assert.deepEqual(await full.sleepIfHidden(5), [101]);
  assert.equal(await full.discard(true), "discarded");

  const closed = enginePageCalls(async () => null, "page-c");
  assert.equal(await closed.evaluate("1"), null);
  assert.deepEqual(await closed.navigationEntries(), []);
  assert.deepEqual(await closed.pageCookies([]), []);
  assert.deepEqual(await closed.sleepIfHidden(5), [-1]);
  assert.equal(await closed.discard(false), "refused");
  assert.equal(await closed.getSecurityInfo(), null);
  assert.deepEqual(await closed.clearSiteData(), { cookies: false, storage: false });
});

test("a failed engine call rejects with the engine's error, through the Windows page view and the shared page view alike", async () => {
  const failing = { mediaCommand: engineError("the page is gone"), evaluate: engineError("no context"), reload: engineError("no tab") };
  const page = enginePageCalls(host(failing).call, "page-d");
  await assert.rejects(page.mediaCommand("play"), { message: "the page is gone" });
  await assert.rejects(page.evaluate("1"), { message: "no context" });
  const shared = webViewHandle({ current: { ...page, nativeTag: null } });
  await assert.rejects(shared.mediaCommand("play"), { name: "ArdiaError", code: "ERR_ENGINE", message: "the page is gone" });
  await assert.rejects(shared.reload(), { name: "ArdiaError", code: "ERR_ENGINE", message: "no tab" });
});

test("the shared page view reaches the Windows calls with the engine's address", async () => {
  const { call, received } = host({ evaluate: { result: "true" } });
  const shared = webViewHandle({ current: { ...enginePageCalls(call, "page-e"), nativeTag: null } });
  await shared.loadUrl("ardia://settings", { userInitiated: true });
  assert.equal(await shared.evaluate("1"), true);
  assert.deepEqual(received, [
    ["page-e", "loadUrl", { url: "chrome://settings", userInitiated: true }],
    ["page-e", "evaluate", { code: "1" }],
  ]);
});

test("an engine reply of the wrong shape rejects as a bad reply instead of reading as an empty answer", async () => {
  const page = enginePageCalls(host({ evaluate: { result: { title: "A" } }, navigationEntries: { entries: { url: "x" } }, pageCookies: { cookies: "n=v" } }).call, "page-f");
  await assert.rejects(page.evaluate("1"), { code: "ERR_BAD_REPLY" });
  await assert.rejects(page.navigationEntries(), { code: "ERR_BAD_REPLY" });
  await assert.rejects(page.pageCookies([]), { code: "ERR_BAD_REPLY" });
  await assert.rejects(webViewHandle({ current: { ...page, nativeTag: null } }).evaluate("1"), { name: "ArdiaError", code: "ERR_BAD_REPLY" });
});

test("the shared page view's tag is the one the native view recorded, and none on Windows or before the view mounts", () => {
  assert.equal(webViewHandle({ current: { nativeTag: 42 } }).nativeTag(), 42);
  assert.equal(webViewHandle({ current: { nativeTag: null } }).nativeTag(), null);
  assert.equal(webViewHandle({ current: null }).nativeTag(), null);
});

test("a call Windows has no engine for yet answers what the Mac answers when it can't, and logs its name", async () => {
  const expected = {
    downloadImage: null,
    requestPictureInPicture: false,
    takeControlPress: false,
    exitPictureInPicture: undefined,
    resolvePasswordPrompt: undefined,
    resolveAutofillPrompt: undefined,
    answerAutofillPrompt: false,
    executeExtensionAction: null,
    resolveDisplayMedia: undefined,
    mediaCaptureSourceId: null,
    notificationAction: undefined,
  };
  assert.deepEqual(Object.keys(NOT_ON_WINDOWS_YET).sort(), Object.keys(expected).sort());
  for (const [method, answer] of Object.entries(expected)) assert.equal(await NOT_ON_WINDOWS_YET[method]("x", 1), answer, method);
  for (const method of Object.keys(expected)) assert.ok(missingOnWindows().includes(`<ArdiaWebView>.${method}`), method);
});
