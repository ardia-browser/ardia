import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

const native = await import("../../../test-native/ardiacore.ts");
const { useBrowser } = await import("../../../state/browser/store.ts");
const { loadApplePasswords } = await import("../../../state/site/applePasswords.ts");
const { choosePasswordManager } = await import("../../../state/site/passwordManager.ts");
const { iCloudExtensionSettled } = await import("../../../state/site/iCloudPasswordsExtension.ts");
const ui = await import("../../ui/index.ts");
const form = await import("../Form.tsx");
const { PasswordManagerRow } = await import("./PasswordManagerRow.tsx");

const ICLOUD = "pejdijmoenmkgeppbflobdenhhabjlaj";
const S = () => useBrowser.getState();
const LEAVES = new Set([...Object.values(ui), ...Object.values(form)]);

const extensions = new Map();
globalThis.acTestUserScripts = {
  engine: {
    list: async (profile) => [...(extensions.get(profile) ?? new Map()).values()],
    setEnabled: async (id, profile, enabled) => {
      const ext = extensions.get(profile)?.get(id);
      if (ext) ext.enabled = enabled;
    },
    install: async () => "x",
    reload: async () => {},
    uninstall: async (id, profile) => void extensions.get(profile)?.delete(id),
  },
};

function find(node, match, found = []) {
  if (Array.isArray(node)) node.forEach((n) => find(n, match, found));
  else if (node && typeof node === "object" && "props" in node) {
    if (match(node)) found.push(node);
    find(node.props.children, match, found);
  }
  return found;
}

function render(node) {
  if (Array.isArray(node)) return node.map(render);
  if (!node || typeof node !== "object" || !("props" in node)) return node;
  if (typeof node.type === "function" && !LEAVES.has(node.type)) return render(mount(() => node.type(node.props)).value);
  return { ...node, props: { ...node.props, children: render(node.props.children) } };
}

function noteOf(profileId) {
  const tree = render(mount(() => PasswordManagerRow({ profileId })).value);
  const [row] = find(tree, (n) => n.type === form.Row && n.props.title === "iCloud Passwords extension");
  if (!row) return null;
  const [button] = find(row, (n) => n.type === ui.Button);
  return { text: row.props.description, button: button?.props.title ?? null, press: button?.props.onPress };
}

test("Settings says Ardia turned the iCloud Passwords extension off, and Turn it back on turns it on and drops the note", async () => {
  native.applePasswords.state = "connected";
  S().hydrate({});
  S().createWindow({ url: "https://a.test/" });
  await loadApplePasswords();
  const profileId = S().settings.defaultProfileId;
  extensions.set("", new Map([[ICLOUD, { id: ICLOUD, name: "iCloud Passwords", enabled: true }]]));
  choosePasswordManager(profileId, "apple");
  await iCloudExtensionSettled();
  assert.equal(extensions.get("").get(ICLOUD).enabled, false, "picking Apple Passwords turns it off");
  const note = noteOf(profileId);
  assert.deepEqual({ text: note?.text, button: note?.button }, { text: "Ardia now fills from Apple Passwords itself. You can remove the iCloud Passwords extension.", button: "Turn it back on" });
  await note.press();
  await iCloudExtensionSettled();
  assert.equal(extensions.get("").get(ICLOUD).enabled, true, "Turn it back on turns it on");
  assert.equal(noteOf(profileId), null, "the note goes away");
  assert.ok(extensions.get("").has(ICLOUD), "never uninstalled");
});
