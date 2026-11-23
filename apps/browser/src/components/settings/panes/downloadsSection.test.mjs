import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { mount } from "../../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

const CHROME_DEFAULT = { folder: "/Users/someone/Downloads", askWhereToSave: false, managed: false };
let engine;
let picked;
globalThis.acTestNativeModules = {
  ArdiaDownloads: {
    call: (verb, profile, json) => {
      const next = { ...CHROME_DEFAULT, ...engine.get(profile), ...JSON.parse(json) };
      if (verb === "setSettings") engine.set(profile, next);
      return sleep(1).then(() => JSON.stringify(next));
    },
    addListener: () => ({ remove() {} }),
  },
  ArdiaDialogs: { pickFolder: () => picked.promise },
};

await import("../../../test-native/index.ts");
const { useBrowser } = await import("../../../state/browser/store.ts");
const { engineProfiles } = await import("../../../state/profiles/engineProfiles.ts");
const { GeneralPane } = await import("./General.tsx");

const S = () => useBrowser.getState();
const settled = () => sleep(40);
const folders = () => engineProfiles(S()).map((profile) => (engine.get(profile) ?? CHROME_DEFAULT).folder);
const asks = () => engineProfiles(S()).map((profile) => (engine.get(profile) ?? CHROME_DEFAULT).askWhereToSave);

function elements(node, found = []) {
  if (Array.isArray(node)) for (const child of node) elements(child, found);
  else if (node?.props) {
    found.push(node);
    elements(node.props.children, found);
  }
  return found;
}

async function openDownloads() {
  const section = elements(GeneralPane({})).find((element) => element.type.name === "DownloadsSection");
  const page = mount(() => section.type({}));
  await settled();
  return page;
}

const control = (page, anchor) => elements(page.value).find((element) => element.props.anchor === anchor).props.children.props;

beforeEach(() => {
  engine = new Map();
  picked = Promise.withResolvers();
  S().hydrate({});
});

test("a folder picked while a profile was being added is every profile's, so the switch stays off", async () => {
  const page = await openDownloads();
  control(page, "general.downloadsFolder").onPress();
  S().createProfile({ name: "Synced" });
  await settled();
  picked.resolve("/Users/someone/Picked");
  await settled();
  assert.deepEqual(folders(), ["/Users/someone/Picked", "/Users/someone/Picked"]);
  page.unmount();
  const reopened = await openDownloads();
  assert.equal(S().settings.separateDownloadFolders, false);
  reopened.unmount();
});

test("Ask where to save pressed before General redraws with a new profile reaches that profile", async () => {
  const page = await openDownloads();
  const toggle = control(page, "general.askWhereToSave");
  S().createProfile({ name: "Synced" });
  await settled();
  toggle.onChange(true);
  await settled();
  assert.deepEqual(asks(), [true, true]);
  page.unmount();
});

test("turning the switch off puts a profile added since General drew on the one folder", async () => {
  S().updateSettings({ separateDownloadFolders: true });
  engine.set("", { ...CHROME_DEFAULT, folder: "/Users/someone/Mine" });
  const page = await openDownloads();
  const toggle = control(page, "general.separateDownloadFolders");
  S().createProfile({ name: "Synced" });
  await settled();
  toggle.onChange(false);
  await settled();
  assert.deepEqual(folders(), ["/Users/someone/Mine", "/Users/someone/Mine"]);
  assert.equal(S().settings.separateDownloadFolders, false);
  page.unmount();
});

test("turning the switch off right after Ask where to save keeps what was just chosen", async () => {
  S().createProfile({ name: "Work" });
  await settled();
  S().updateSettings({ separateDownloadFolders: true });
  const page = await openDownloads();
  const toggle = control(page, "general.separateDownloadFolders");
  control(page, "general.askWhereToSave").onChange(true);
  toggle.onChange(false);
  await settled();
  assert.deepEqual(asks(), [true, true]);
  page.unmount();
});

test("turning the switch off copies the default profile's folder as it is when the write runs", async () => {
  S().createProfile({ name: "Work" });
  await settled();
  S().updateSettings({ separateDownloadFolders: true });
  const page = await openDownloads();
  const toggle = control(page, "general.separateDownloadFolders");
  engine.set("", { ...CHROME_DEFAULT, folder: "/Users/someone/Changed" });
  toggle.onChange(false);
  await settled();
  assert.deepEqual(folders(), ["/Users/someone/Changed", "/Users/someone/Changed"]);
  page.unmount();
});

test("turning the switch off and straight back on leaves each profile's own folder", async () => {
  const work = S().createProfile({ name: "Work" });
  await settled();
  S().updateSettings({ separateDownloadFolders: true });
  engine.set(work, { ...CHROME_DEFAULT, folder: "/Users/someone/Work" });
  const page = await openDownloads();
  const toggle = control(page, "general.separateDownloadFolders");
  toggle.onChange(false);
  toggle.onChange(true);
  await settled();
  assert.deepEqual(folders(), ["/Users/someone/Downloads", "/Users/someone/Work"]);
  page.unmount();
});
