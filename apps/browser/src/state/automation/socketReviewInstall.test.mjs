import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { useExtensions, confirmInstall, cancelInstall, showInstallPrompt, loadUnpacked, refreshExtensions, utilitySheetHost } = await import("../extensions/actions.ts");
const { SETTINGS_WINDOW_ID } = await import("../settings/settingsWindows.ts");
const stub = await import("../../test-native/index.ts");
const { extensionWorld, gate, row } = await import("./fixtures/extensionWorld.mjs");

const S = () => useBrowser.getState();
after(() => S().updateSettings({ cliControl: false }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};
let nextId = 0;
const CONNECTION = 62;

function send(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: CONNECTION, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  const mine = () => stub.controlSocket.replies.slice(before).find((r) => r.connection === CONNECTION && JSON.parse(r.line).id === id);
  return async () => {
    for (let i = 0; i < 400 && !mine(); i++) await tick();
    assert.ok(mine(), `a reply to ${method}`);
    return JSON.parse(mine().line);
  };
}
const call = (method, params) => send(method, params)();
const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};

async function setup() {
  cancelInstall();
  useExtensions.setState({ install: null, lists: {} });
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://a.example/" });
  return { windowId, ...extensionWorld() };
}

async function loadFromSettings(folder, profile = "") {
  stub.chosenExtensionFolder.next = folder;
  try {
    assert.equal(await loadUnpacked(SETTINGS_WINDOW_ID, profile), true);
  } finally {
    stub.chosenExtensionFolder.next = null;
  }
  return useExtensions.getState().install;
}

test("a socket folder install is refused on every platform, before any path check or read", async () => {
  const { folders } = await setup();
  folders.set("/tmp/x/ext", { id: "x" });
  let inspected = 0;
  const engine = globalThis.acTestUserScripts.engine;
  const inspect = engine.inspect;
  engine.inspect = async (...args) => (inspected++, inspect(...args));
  try {
    for (const params of [{ folder: "/tmp/x/ext" }, { folder: "relative" }, { folder: "/tmp/x/ext", webStore: "abcdefghijklmnopabcdefghijklmnop" }]) {
      const reply = await call("extensions.install", params);
      assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
      assert.equal(reply.error.message, "installing an unpacked folder from the socket isn't supported; use Settings › Extensions › Load Unpacked");
    }
    assert.equal((await call("extensions.install", { folder: null })).error?.code, "bad_request", "a folder that isn't a string fails the schema first");
    assert.equal(inspected, 0);
    assert.equal(useExtensions.getState().install, null);
  } finally {
    engine.inspect = inspect;
  }
});

test("Settings' Load Unpacked inspects and installs the chosen folder in place, as on main", async () => {
  const { folders, installs, list } = await setup();
  folders.set("/Users/me/dev/ext", { id: "inplace", version: "1.0" });
  const shown = await loadFromSettings("/Users/me/dev/ext");
  assert.deepEqual([shown.status, shown.pkg.path, shown.windowId], ["ready", "/Users/me/dev/ext", SETTINGS_WINDOW_ID]);
  assert.deepEqual(Object.keys(shown.pkg).filter((k) => ["digest", "staged", "installId", "installPath"].includes(k)), []);
  await confirmInstall(shown.key);
  assert.deepEqual(installs, [{ path: "/Users/me/dev/ext", id: "inplace", version: "1.0" }]);
  assert.equal(list[0].path, "/Users/me/dev/ext");
  assert.equal(useExtensions.getState().install, null);
});

test("once Add is pressed, Cancel and a competing prompt leave the install alone, and the prompt shows after", async () => {
  const { folders, gates, installs, windowId } = await setup();
  folders.set("/tmp/h/ext", { id: "hhh" });
  const shown = await loadFromSettings("/tmp/h/ext");
  const held = gate();
  gates.install = held.shut;
  void confirmInstall(shown.key);
  await settle();
  cancelInstall(shown.key);
  showInstallPrompt(windowId, { requestId: "r1", profile: "", type: "install", name: "Other", icon: "", permissions: [] });
  await settle();
  assert.equal(useExtensions.getState().install?.status, "installing", "the sheet stays on Adding…");
  held.open();
  await settle();
  assert.equal(installs.length, 1);
  assert.equal(useExtensions.getState().install?.status, "prompt", "the prompt that came in meanwhile shows once the install is done");
  cancelInstall();
  gates.install = null;
});

test("closing the window while Adding… leaves no error sheet behind for a window that's gone", async () => {
  const { folders, gates } = await setup();
  const other = S().createWindow({ url: "https://b.example/" });
  folders.set("/tmp/i/ext", { id: "iii" });
  stub.chosenExtensionFolder.next = "/tmp/i/ext";
  await loadUnpacked(other, "");
  stub.chosenExtensionFolder.next = null;
  const shown = useExtensions.getState().install;
  const refusal = gate();
  gates.install = refusal.shut.then(() => {
    throw new Error("Chromium refused it");
  });
  void confirmInstall(shown.key);
  await settle();
  S().closeWindow(other);
  refusal.open();
  await settle();
  assert.equal(useExtensions.getState().install, null);
  gates.install = null;
});

test("a failed Add after the Settings sheet closed frees the slot, and a held store prompt goes to a window that can show it", async () => {
  const { folders, gates, windowId } = await setup();
  folders.set("/tmp/s/ext", { id: "sss" });
  const closeHost = utilitySheetHost(SETTINGS_WINDOW_ID);
  const shown = await loadFromSettings("/tmp/s/ext");
  const refusal = gate();
  gates.install = refusal.shut.then(() => {
    throw new Error("Chromium refused it");
  });
  void confirmInstall(shown.key);
  await settle();
  showInstallPrompt(SETTINGS_WINDOW_ID, { requestId: "held", profile: "", type: "install", name: "Held", icon: "", permissions: [] });
  closeHost();
  assert.equal(useExtensions.getState().install?.status, "installing", "closing Settings doesn't drop an install already under way");
  refusal.open();
  await settle();
  const now = useExtensions.getState().install;
  assert.deepEqual([now?.status, now?.windowId], ["prompt", windowId], "no error sheet for the closed Settings sheet; the held prompt shows in a browser window");
  cancelInstall();
  gates.install = null;

  const reopen = utilitySheetHost(SETTINGS_WINDOW_ID);
  const again = await loadFromSettings("/tmp/s/ext");
  reopen();
  await settle();
  assert.equal(useExtensions.getState().install, null, `a ready sheet in a closed Settings sheet is let go (${again.key})`);
});

test("a held store prompt never goes to a closing window: it takes another open one, or is declined", async () => {
  const { folders, gates, windowId } = await setup();
  const { startClosingWindow, stopClosingWindow } = await import("../windows/closingWindows.ts");
  folders.set("/tmp/c/ext", { id: "ccc" });
  const settingsHost = utilitySheetHost(SETTINGS_WINDOW_ID);
  const shown = await loadFromSettings("/tmp/c/ext");
  const refusal = gate();
  gates.install = refusal.shut.then(() => {
    throw new Error("Chromium refused it");
  });
  void confirmInstall(shown.key);
  await settle();
  showInstallPrompt(SETTINGS_WINDOW_ID, { requestId: "held-a", profile: "", type: "install", name: "Held", icon: "", permissions: [] });
  settingsHost();
  const other = S().createWindow({ url: "https://b.example/" });
  useBrowser.setState((st) => ({ ui: { ...st.ui, focusOrder: [windowId, other] } }));
  startClosingWindow(windowId);
  refusal.open();
  await settle();
  const now = useExtensions.getState().install;
  assert.deepEqual([now?.status, now?.windowId], ["prompt", other], "the closing window is skipped");
  cancelInstall();

  const declined = [];
  const answer = stub.extensionAnswers.resolveInstallPrompt;
  stub.extensionAnswers.resolveInstallPrompt = async (requestId, accepted) => void declined.push([requestId, accepted]);
  startClosingWindow(other);
  const host = utilitySheetHost(SETTINGS_WINDOW_ID);
  const second = await loadFromSettings("/tmp/c/ext");
  const refusal2 = gate();
  gates.install = refusal2.shut.then(() => {
    throw new Error("Chromium refused it");
  });
  void confirmInstall(second.key);
  await settle();
  showInstallPrompt(SETTINGS_WINDOW_ID, { requestId: "held-b", profile: "", type: "install", name: "Held", icon: "", permissions: [] });
  host();
  refusal2.open();
  await settle();
  assert.equal(useExtensions.getState().install, null, "nothing shows when every window is closing");
  assert.deepEqual(declined, [["held-b", false]], "the held prompt is declined");
  stopClosingWindow(windowId);
  stopClosingWindow(other);
  stub.extensionAnswers.resolveInstallPrompt = answer;
  gates.install = null;
});

test("a held store prompt aimed at a private window shows in a main window instead", async () => {
  const { folders, gates, windowId } = await setup();
  folders.set("/tmp/p/ext", { id: "ppp" });
  const privateWindow = S().createWindow({ kind: "private", url: "https://p.example/" });
  assert.equal(S().windows[privateWindow]?.kind, "private");
  const host = utilitySheetHost(SETTINGS_WINDOW_ID);
  const shown = await loadFromSettings("/tmp/p/ext");
  const held = gate();
  gates.install = held.shut;
  void confirmInstall(shown.key);
  await settle();
  showInstallPrompt(privateWindow, { requestId: "held-p", profile: "", type: "install", name: "Held", icon: "", permissions: [] });
  held.open();
  await settle();
  const now = useExtensions.getState().install;
  assert.deepEqual([now?.status, now?.windowId], ["prompt", windowId]);
  cancelInstall();
  host();
  gates.install = null;
});

test("a held store prompt can go to an open Little Ardia when the main window is closing", async () => {
  const { folders, gates, windowId } = await setup();
  const { startClosingWindow, stopClosingWindow } = await import("../windows/closingWindows.ts");
  folders.set("/tmp/l/ext", { id: "lll" });
  const little = S().createWindow({ kind: "small", url: "https://little.example/" });
  assert.equal(S().windows[little]?.kind, "small");
  useBrowser.setState((st) => ({ ui: { ...st.ui, focusOrder: [windowId, little] } }));
  const host = utilitySheetHost(SETTINGS_WINDOW_ID);
  const shown = await loadFromSettings("/tmp/l/ext");
  const refusal = gate();
  gates.install = refusal.shut.then(() => {
    throw new Error("Chromium refused it");
  });
  void confirmInstall(shown.key);
  await settle();
  showInstallPrompt(SETTINGS_WINDOW_ID, { requestId: "held-l", profile: "", type: "install", name: "Held", icon: "", permissions: [] });
  host();
  startClosingWindow(windowId);
  refusal.open();
  await settle();
  const now = useExtensions.getState().install;
  assert.deepEqual([now?.status, now?.windowId], ["prompt", little]);
  cancelInstall();
  stopClosingWindow(windowId);
  gates.install = null;
});

test("the Web Store fast path checks control after the list it waited on", async () => {
  const { list, gates } = await setup();
  list.push(row("abcdefghijklmnopabcdefghijklmnop"));
  const held = gate();
  gates.list = held.shut;
  const pending = send("extensions.install", { webStore: "abcdefghijklmnopabcdefghijklmnop" });
  await settle();
  S().updateSettings({ cliControl: false });
  held.open();
  assert.equal((await pending()).error?.code, "failed");
  gates.list = null;
});

test("configure changes one setting per call: site access with incognito, or any two settings, is refused with no writes", async () => {
  const { list, writes } = await setup();
  list.push(row("both", { siteAccess: "ON_CLICK", incognitoAllowed: true, userScriptsAvailable: true, sites: ["https://a.example/*"] }));
  for (const incognito of [true, false]) {
    const reply = await call("extensions.configure", { id: "both", siteAccess: "allSites", incognito });
    assert.equal(reply.error?.code, "bad_request", JSON.stringify(reply));
  }
  assert.equal((await call("extensions.configure", { id: "both", siteAccess: "allSites", userScripts: true })).error?.code, "bad_request");
  assert.equal((await call("extensions.configure", { id: "both", incognito: true, userScripts: true })).error?.code, "bad_request");
  assert.deepEqual(writes, [], "nothing was written");
  assert.deepEqual([list[0].siteAccess, list[0].incognito, list[0].sites], ["ON_CLICK", false, ["https://a.example/*"]], "no grant lost");
});

test("specificSites is refused before anything is written, even naming exactly the granted sites; other site access still changes", async () => {
  const { list, writes } = await setup();
  list.push(row("specific", { siteAccess: "ON_SPECIFIC_SITES", sites: ["https://a.example/*"] }), row("broad", { siteAccess: "ON_ALL_SITES", sites: ["https://*/*"] }));
  for (const id of ["specific", "broad"]) {
    const reply = await call("extensions.configure", { id, siteAccess: "specificSites" });
    assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
    assert.equal(reply.error.message, "changing to specific sites needs engine support");
  }
  assert.equal((await call("extensions.configure", { id: "specific", siteAccess: "specificSites", hosts: ["https://a.example/*"] })).error?.code, "bad_request", "hosts is no longer a parameter");
  assert.equal((await call("extensions.configure", { id: "specific" })).error?.code, "bad_request", "nothing named");
  assert.deepEqual(writes, []);
  assert.deepEqual(list.map((x) => [x.siteAccess, x.sites]), [["ON_SPECIFIC_SITES", ["https://a.example/*"]], ["ON_ALL_SITES", ["https://*/*"]]]);
  assert.equal((await ok("extensions.configure", { id: "broad", siteAccess: "onClick" })).siteAccess, "ON_CLICK");
});

test("an extension missing from the readback after the write answers failed, not no_window", async () => {
  const { list } = await setup();
  list.push(row("vanishes", { siteAccess: "ON_ALL_SITES", vanishOnWrite: true }));
  const reply = await call("extensions.configure", { id: "vanishes", siteAccess: "onClick" });
  assert.equal(reply.error?.code, "failed", JSON.stringify(reply));
  assert.match(reply.error.message, /read them back after the change/);
});

test("a successful configure reads the list exactly once after its write", async () => {
  const { list, writes, listCalls } = await setup();
  list.push(row("once", { siteAccess: "ON_CLICK", incognitoAllowed: true }));
  await ok("extensions.configure", { id: "once", incognito: true });
  assert.equal(writes.length, 1);
  assert.equal(listCalls.count - writes[0].listCallsBefore, 1);
});

test("a silently declined Incognito change answers failed, with nothing else touched", async () => {
  const { list, writes } = await setup();
  list.push(row("silent", { siteAccess: "ON_SPECIFIC_SITES", sites: ["https://a.example/*"], incognitoAllowed: true, ignoreIncognito: true }));
  const reply = await call("extensions.configure", { id: "silent", incognito: true });
  assert.equal(reply.error?.code, "failed", JSON.stringify(reply));
  assert.match(reply.error.message, /didn't leave silent's incognito as asked/);
  assert.deepEqual(writes.map(({ id, incognito }) => ({ id, incognito })), [{ id: "silent", incognito: true }], "only the one write");
  assert.deepEqual([list[0].siteAccess, list[0].sites], ["ON_SPECIFIC_SITES", ["https://a.example/*"]]);
});

test("configure refuses Incognito for an unpacked extension, and for unknown eligibility, before any write", async () => {
  const { list, writes } = await setup();
  list.push(
    row("unpacked", { path: "/Users/me/dev/ext", siteAccess: "ON_CLICK", incognitoAllowed: true }),
    row("unpacked-unknown", { path: "/Users/me/dev/other", incognitoAllowed: null }),
    row("linuxish", { siteAccess: "ON_CLICK" }),
    row("unreadable", { siteAccess: "ON_CLICK", incognitoAllowed: null }),
  );
  const unpacked = await call("extensions.configure", { id: "unpacked", incognito: true });
  assert.equal(unpacked.error?.code, "refused", JSON.stringify(unpacked));
  assert.match(unpacked.error.message, /needs engine support/);
  for (const id of ["unpacked-unknown", "linuxish", "unreadable"]) {
    for (const incognito of [true, false]) {
      const reply = await call("extensions.configure", { id, incognito });
      assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
      assert.match(reply.error.message, /can't confirm incognito eligibility/);
    }
  }
  assert.deepEqual(writes, []);
  assert.equal((await ok("extensions.configure", { id: "unpacked", siteAccess: "allSites" })).siteAccess, "ON_ALL_SITES", "site access on its own still changes");
});

test("configure checks a packed extension's Incognito against the list Chromium gives now, not the cached row", async () => {
  const { list } = await setup();
  list.push(row("packed", { siteAccess: "ON_CLICK", incognitoAllowed: true }));
  await refreshExtensions("");
  list[0].incognitoAllowed = false;
  const reply = await call("extensions.configure", { id: "packed", incognito: true });
  assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
  list[0].incognitoAllowed = true;
  assert.equal((await ok("extensions.configure", { id: "packed", incognito: true })).incognito, true);
});

test("configure answers failed when the readback after its write fails, never the cached row", async () => {
  const { list, gates } = await setup();
  list.push(row("rb", { incognitoAllowed: true }));
  await refreshExtensions("");
  gates.breakListsOnWrite = true;
  const reply = await call("extensions.configure", { id: "rb", incognito: true });
  gates.breakListsOnWrite = false;
  gates.listFails = false;
  assert.equal(list[0].incognito, true, "the write happened");
  assert.equal(reply.error?.code, "failed", JSON.stringify(reply));
  assert.match(reply.error.message, /couldn't read the profile's extensions/);
});

test("the Web Store fast path answers failed when Chromium's list can't be read, and Load Unpacked reports a refused sheet", async () => {
  const { list, gates, folders } = await setup();
  list.push(row("abcdefghijklmnopabcdefghijklmnop"));
  await refreshExtensions("");
  gates.listFails = true;
  assert.equal((await call("extensions.install", { webStore: "abcdefghijklmnopabcdefghijklmnop" })).error?.code, "failed");
  gates.listFails = false;
  folders.set("/tmp/q/ext", { id: "qqq" });
  const first = await loadFromSettings("/tmp/q/ext");
  gates.install = gate().shut;
  void confirmInstall(first.key);
  await settle();
  stub.chosenExtensionFolder.next = "/tmp/q/ext";
  assert.equal(await loadUnpacked(SETTINGS_WINDOW_ID, ""), false, "a sheet refused while another install runs isn't reported as shown");
  stub.chosenExtensionFolder.next = null;
  gates.install = null;
});
