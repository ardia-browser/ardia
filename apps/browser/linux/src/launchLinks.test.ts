import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { WebContents } from "electron";

const dataDir = mkdtempSync(join(tmpdir(), "ardia-launch-links-"));
process.env.ARDIA_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const { app } = await import("electron");
const { addReceiver } = await import("./bridge.ts");
const launchLinks = await import("./launchLinks.ts");

type Sent = { module: string; event: string; payload: unknown };
const sent: Sent[] = [];
const ui = { isDestroyed: () => false, once: () => undefined, send: (_channel: string, module: string, event: string, payload: unknown) => sent.push({ module, event, payload }) };
addReceiver(ui as unknown as WebContents);

const openedLinks = () => sent.filter((message) => message.event === "onOpenURLs").map((message) => (message.payload as { urls: string[] }).urls);
const secondLaunch = (...links: string[]) => app.emit("second-instance", {}, [process.execPath, ...links], process.cwd());

test("links from a second launch during startup wait with the first launch's links until the UI listens", () => {
  process.argv = [process.execPath, "https://first.example/"];
  launchLinks.installLaunchLinks();
  app.emit("browser-window-created", {}, {});
  secondLaunch("https://second.example/");
  assert.deepEqual(openedLinks(), [], "links went out before the UI was listening");
  launchLinks.uiListening();
  assert.deepEqual(openedLinks(), [["https://first.example/", "https://second.example/"]]);
  assert.equal(launchLinks.takeOpenedAtLaunch(), 1);
});

test("once the UI listens, a second launch's links go straight to it, and only once", () => {
  sent.length = 0;
  secondLaunch("https://third.example/");
  assert.deepEqual(openedLinks(), [["https://third.example/"]]);
  launchLinks.uiListening();
  assert.deepEqual(openedLinks(), [["https://third.example/"]]);
  assert.equal(launchLinks.takeOpenedAtLaunch(), 0);
});

test("a UI that reloads holds links again until it listens again", () => {
  sent.length = 0;
  launchLinks.uiStopped();
  secondLaunch("https://during-reload.example/");
  assert.deepEqual(openedLinks(), []);
  launchLinks.uiListening();
  assert.deepEqual(openedLinks(), [["https://during-reload.example/"]]);
});
