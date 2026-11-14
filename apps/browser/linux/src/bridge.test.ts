import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { after, mock, test } from "node:test";
import type { WebContents } from "electron";

const dataDir = mkdtempSync(join(tmpdir(), "ardia-bridge-"));
const uiDir = join(dataDir, "ui");
process.env.ARDIA_DATA_DIR = dataDir;
process.env.ARDIA_UI_DIR = uiDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const { ipcMain, session } = await import("./testing/electron.ts");
const { defineModule, installBridge } = await import("./bridge.ts");
const { acceptsPage, trustHost } = await import("./ipcSenders.ts");

const APP_URL = pathToFileURL(join(uiDir, "index.html")).href;
type Frame = { url: string; parent: Frame | null };
let nextId = 1;

function contents(type: string, url: string, inSession: object = session.defaultSession) {
  const mainFrame: Frame = { url, parent: null };
  return Object.assign(new EventEmitter(), {
    id: nextId++,
    mainFrame,
    session: inSession,
    getType: () => type,
    getURL: () => mainFrame.url,
    isDestroyed: () => false,
  });
}
type Contents = ReturnType<typeof contents>;

const host = contents("window", APP_URL);
const appWindow = contents("window", "about:blank");
const page = contents("webview", "https://evil.example/", {
  name: "persist:ardia",
});
const popup = contents("window", "https://login.example/", {
  name: "persist:ardia",
});

let calls = 0;
defineModule("Probe", {
  sync: { secret: () => ++calls },
  async: { later: async () => ++calls },
});
installBridge();
trustHost(host as unknown as WebContents);

type Reply = { value?: unknown; error?: string; code?: string };
function syncEvent(sender: Contents, frame: Frame | null, channel: string, ...args: unknown[]) {
  const event = {
    sender,
    senderFrame: frame,
    returnValue: undefined as unknown,
  };
  ipcMain.emit(channel, event, ...args);
  return { answer: (): unknown => event.returnValue };
}
const syncCall = (sender: Contents, frame: Frame | null, channel: string, ...args: unknown[]) => syncEvent(sender, frame, channel, ...args).answer();
const settle = () => new Promise((resolve) => setImmediate(resolve));
const asyncCall = (sender: Contents, frame: Frame | null, ...args: unknown[]) =>
  ipcMain.invoke("ardia:call", { sender, senderFrame: frame }, ...args) as Promise<Reply>;

test("the host's main frame on the app document reaches every bridge channel", async () => {
  assert.deepEqual(Object.keys(syncCall(host, host.mainFrame, "ardia:modules") as object), ["Probe"]);
  assert.deepEqual(syncCall(host, host.mainFrame, "ardia:callSync", "Probe", "secret", []), { value: 1 });
  assert.deepEqual(await asyncCall(host, host.mainFrame, "Probe", "later", []), { value: 2 });
});

test("pages, app windows, subframes and a navigated host are refused before anything runs", async () => {
  const before = calls;
  const strangers: [string, Contents, Frame | null][] = [
    ["a page", page, page.mainFrame],
    ["a page popup", popup, popup.mainFrame],
    ["an app window", appWindow, appWindow.mainFrame],
    ["a frame inside the host", host, { url: APP_URL, parent: host.mainFrame }],
    ["the host without a frame", host, null],
  ];
  for (const [who, sender, frame] of strangers) {
    const modulesEvent = syncEvent(sender, frame, "ardia:modules");
    const callEvent = syncEvent(sender, frame, "ardia:callSync", "Probe", "secret", []);
    await settle();
    assert.deepEqual(modulesEvent.answer(), {}, who);
    assert.equal((callEvent.answer() as Reply).code, "ERR_LINUX_BRIDGE_SENDER", who);
    assert.equal((await asyncCall(sender, frame, "Probe", "later", [])).code, "ERR_LINUX_BRIDGE_SENDER", who);
  }
  host.mainFrame.url = "https://evil.example/";
  const elsewhere = syncEvent(host, host.mainFrame, "ardia:callSync", "Probe", "secret", []);
  await settle();
  assert.equal((elsewhere.answer() as Reply).code, "ERR_LINUX_BRIDGE_SENDER", "the host on another document");
  host.mainFrame.url = `${APP_URL}#/settings`;
  assert.equal((syncCall(host, host.mainFrame, "ardia:callSync", "Probe", "secret", []) as Reply).code, undefined, "the app document with a fragment");
  host.mainFrame.url = APP_URL;
  assert.equal(calls, before + 1);
});

test("each refused sender is logged once", async () => {
  for (let tries = 0; tries < 3; tries++) syncCall(page, page.mainFrame, "ardia:callSync", "Probe", "secret", []);
  await settle();
  const log = readFileSync(join(dataDir, "launch.log"), "utf8");
  assert.equal(log.split("\n").filter((line) => line.includes(`webview ${page.id} `)).length, 1);
});

test("a call from the host's new document that arrives before main saw it commit waits for the commit, then runs", async () => {
  const committed = host.mainFrame;
  const arriving: Frame = { url: "", parent: null };
  const before = calls;
  const modulesEvent = syncEvent(host, arriving, "ardia:modules");
  const callEvent = syncEvent(host, arriving, "ardia:callSync", "Probe", "secret", []);
  const asyncReply = asyncCall(host, arriving, "Probe", "later", []);
  await settle();
  assert.equal(modulesEvent.answer(), undefined, "answered before the commit");
  assert.equal(calls, before);
  arriving.url = APP_URL;
  host.mainFrame = arriving;
  host.emit("did-navigate");
  await settle();
  assert.deepEqual(Object.keys(modulesEvent.answer() as object), ["Probe"]);
  assert.deepEqual(callEvent.answer(), { value: before + 1 });
  assert.deepEqual(await asyncReply, { value: before + 2 });
  host.mainFrame = committed;
});

test("a host frame that never commits the app document is refused when the wait ends", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const stuck: Frame = { url: "", parent: null };
    const event = syncEvent(host, stuck, "ardia:callSync", "Probe", "secret", []);
    await settle();
    assert.equal(event.answer(), undefined);
    mock.timers.tick(5000);
    await settle();
    assert.equal((event.answer() as Reply).code, "ERR_LINUX_BRIDGE_SENDER");
  } finally {
    mock.timers.reset();
  }
});

test("page channels accept frames in page sessions, never the host or app windows", () => {
  const event = (sender: Contents, frame: Frame | null) => ({ sender, senderFrame: frame }) as unknown as Electron.IpcMainEvent;
  assert.equal(acceptsPage(event(page, page.mainFrame), "probe"), true);
  assert.equal(acceptsPage(event(page, { url: "https://frame.example/", parent: page.mainFrame }), "probe"), true);
  assert.equal(acceptsPage(event(popup, popup.mainFrame), "probe"), true);
  assert.equal(acceptsPage(event(host, host.mainFrame), "probe"), false);
  assert.equal(acceptsPage(event(appWindow, appWindow.mainFrame), "probe"), false);
  assert.equal(acceptsPage(event(page, null), "probe"), false);
});
