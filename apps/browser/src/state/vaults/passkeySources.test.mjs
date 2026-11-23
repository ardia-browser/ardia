import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const sources = await import("./passkeySources.ts");
const { useBrowser } = await import("../browser/store.ts");

const PROTON = "ghmbeldphafepmbegfdlkpapadhbakde";
const UNKNOWN = "abcdefghijklmnopabcdefghijklmnop";
const ext = (id, name, enabled = true) => ({ id, name, enabled, icon: "" });

test("only enabled extensions known for passkeys, or seen wrapping them, are sources", () => {
  const lists = { "": [ext(PROTON, "Proton Pass"), ext(UNKNOWN, "Some Wallet"), ext("nngceckbapebfimnlniiiahkandclblb", "Bitwarden", false)] };
  assert.deepEqual(sources.passkeyExtensions(lists, []).map((e) => e.name), ["Proton Pass"]);
  assert.deepEqual(sources.passkeyExtensions(lists, [UNKNOWN]).map((e) => e.name), ["Proton Pass", "Some Wallet"]);
  assert.deepEqual(sources.passkeyExtensions({ "": [ext(PROTON, "Proton Pass: Free Password Manager")] }, []).map((e) => e.name), ["Proton Pass"], "store taglines are cut");
  assert.equal(sources.shortExtensionName("1Password \u2013 Password Manager"), "1Password");
  assert.equal(sources.shortExtensionName("Bitwarden Password Manager"), "Bitwarden Password Manager");
  assert.deepEqual(sources.passkeyExtensions({ "": [ext(PROTON, "Proton Pass")], work: [ext(PROTON, "Proton Pass")] }, []).length, 1, "one row per extension across profiles");
});

test("the choice falls back to Ask when its extension is gone, and offers Ask, Ardia, each extension and Chrome", () => {
  const available = [{ id: PROTON, name: "Proton Pass", icon: "" }];
  assert.equal(sources.effectiveSource(`ext:${PROTON}`, available), `ext:${PROTON}`);
  assert.equal(sources.effectiveSource(`ext:${PROTON}`, []), "ask");
  assert.equal(sources.effectiveSource("chrome", []), "chrome");
  assert.equal(sources.effectiveSource("whatever", available), "ask");
  assert.deepEqual(
    sources.sourceOptions(available).map((o) => o.title),
    ["Ask Each Time", "Ardia", "Proton Pass", "Chrome (Security Key or Phone)"],
  );
});

test("extensions seen wrapping WebAuthn are remembered once, known ones aren't stored", () => {
  useBrowser.getState().updateSettings({ vaultPasskeyExtensions: [] });
  sources.noteObservedExtensions([UNKNOWN, PROTON, "not-an-id", UNKNOWN]);
  sources.noteObservedExtensions([UNKNOWN]);
  assert.deepEqual(useBrowser.getState().settings.vaultPasskeyExtensions, [UNKNOWN]);
});

test("telemetry names a known extension's vendor and everything else other", () => {
  assert.equal(sources.passkeyVendorOf(PROTON), "proton");
  assert.equal(sources.passkeyVendorOf("aeblfdkhhhdcdjpifhhbdiojplfjncoa"), "onepassword");
  assert.equal(sources.passkeyVendorOf(UNKNOWN), "other");
});
