import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import type { WebContents } from "electron";

const dataDir = mkdtempSync(join(tmpdir(), "ardia-navigation-"));
const uiDir = join(dataDir, "ui");
process.env.ARDIA_DATA_DIR = dataDir;
process.env.ARDIA_UI_DIR = uiDir;
Object.assign(globalThis, { __dirname: join(dataDir, "out") });
after(() => rmSync(dataDir, { recursive: true, force: true }));

const { FakeWebContents } = await import("./testing/electron.ts");
const { createHost, shapeNextWindow, shapeNextAuxiliaryWindow } = await import("./windows.ts");

const APP_URL = pathToFileURL(join(uiDir, "index.html")).href;
const host = createHost(async () => undefined).webContents as unknown as InstanceType<typeof FakeWebContents>;

function tries(contents: InstanceType<typeof FakeWebContents>, event: string, url: string, isMainFrame = true): boolean {
  let prevented = false;
  contents.emit(event, { url, isMainFrame, preventDefault: () => (prevented = true) }, url);
  return !prevented;
}

const NAVIGATIONS = ["will-navigate", "will-frame-navigate", "will-redirect"];

test("the host stays on the app document", () => {
  for (const event of NAVIGATIONS) {
    assert.equal(tries(host, event, "https://evil.example/"), false, event);
    assert.equal(tries(host, event, "file:///etc/passwd"), false, event);
    assert.equal(tries(host, event, "about:blank"), false, event);
    assert.equal(tries(host, event, APP_URL), true, event);
    assert.equal(tries(host, event, `${APP_URL}#/again`), true, event);
  }
  assert.equal(tries(host, "will-frame-navigate", "about:blank", false), true, "a blank frame in the UI");
  assert.equal(tries(host, "will-frame-navigate", "https://evil.example/", false), false, "a web frame in the UI");
});

test("the host opens only about:blank windows that were shaped first, each name once", () => {
  const open = (url: string, frameName: string) => host.openHandler!({ url, frameName }).action;
  assert.equal(open("https://evil.example/", "w1"), "deny");
  assert.equal(open("about:blank", "never-shaped"), "deny");
  shapeNextWindow("w2", { width: 800, height: 600 });
  assert.equal(open("https://evil.example/", "w2"), "deny");
  assert.equal(open("about:blank", "w2"), "deny", "a refused open uses up its shape");
  shapeNextWindow("w3", { width: 800, height: 600 });
  assert.equal(open("about:blank", "w3"), "allow");
  assert.equal(open("about:blank", "w3"), "deny");
  shapeNextAuxiliaryWindow("ardia-drag-preview", { width: 1, height: 1 });
  assert.equal(open("about:blank", "ardia-drag-preview"), "allow");
});

test("an app window stays on about:blank and opens nothing", () => {
  const child = new FakeWebContents();
  host.emit("did-create-window", { webContents: child, once: () => undefined }, { frameName: "w3" });
  for (const event of NAVIGATIONS) {
    assert.equal(tries(child, event, "https://evil.example/"), false, event);
    assert.equal(tries(child, event, APP_URL), false, event);
    assert.equal(tries(child, event, "about:blank"), true, event);
  }
  assert.equal(child.openHandler!({ url: "about:blank", frameName: "x" }).action, "deny");
  assert.equal(child.openHandler!({ url: "https://evil.example/", frameName: "" }).action, "deny");
});
