import assert from "node:assert/strict";
import { test } from "node:test";
const { installPhase, installWatch } = await import("./consentInstall.ts");
const { consentKeyDown, FRESH_CONSENT_KEYS } = await import("./consentKeys.ts");
const { CONFIRM_REFUSED } = await import("./consentSurface.ts");
const { UNSAVED } = await import("./store.ts");

const HASH = "a".repeat(64);
const OLD = "b".repeat(64);
const REQUEST = { id: 7, name: "cli", hash: HASH };
const store = (patch = {}) => ({ consent: null, records: { cli: { enabled: true, approved: HASH, values: {}, applied: {} } }, fetches: {}, programs: {}, unsaved: null, ...patch });
const phase = (patch, program = "ardia", retry = null) => installPhase(installWatch(store(patch), REQUEST, program, retry));

test("after Install the sheet follows the real install: waiting, unpacking, linking, then installed", () => {
  assert.deepEqual(phase({ consent: { id: 7, name: "cli", hash: HASH }, records: {} }), { step: "installing", label: "Installing…", fraction: null }, "a confirm still waiting on its preflight is installing, not refused");
  assert.deepEqual(phase({ fetches: { cli: { state: "promoting" } } }), { step: "installing", label: "Installing…", fraction: null });
  assert.deepEqual(phase({ fetches: { cli: { state: "fetching", received: 30, total: 120 } } }), { step: "installing", label: "Downloading…", fraction: 0.25 });
  assert.equal(phase({ fetches: { cli: { state: "fetching", received: 0, total: 0 } } }).fraction, null, "an unknown size is indeterminate");
  assert.deepEqual(phase({}), { step: "installing", label: "Adding ardia to your PATH…", fraction: null }, "no linking news yet");
  assert.equal(phase({ programs: { cli: { state: "linked", hash: OLD, linked: ["ardia"], refused: {}, binDir: "/b" } } }).step, "installing", "the last version's link doesn't count");
  assert.deepEqual(phase({ programs: { cli: { state: "linked", hash: HASH, linked: ["ardia"], refused: {}, binDir: "/b" } } }), { step: "installed" });
  assert.deepEqual(phase({}, null), { step: "installed" }, "a plugin with no program is done once it's on");
});

test("every way an install fails ends in one line the sheet can show, with Try Again", () => {
  assert.deepEqual(phase({ fetches: { cli: { state: "failed", code: "failed", reason: "plugins.json couldn't be saved." } } }), { step: "failed", reason: "plugins.json couldn't be saved." });
  assert.deepEqual(phase({ records: {}, unsaved: "cli" }), { step: "failed", reason: UNSAVED });
  assert.deepEqual(phase({ records: {} }), { step: "failed", reason: CONFIRM_REFUSED });
  assert.deepEqual(phase({ records: { cli: { enabled: true, approved: OLD, values: {}, applied: {} } } }), { step: "failed", reason: CONFIRM_REFUSED }, "another version on record isn't this install");
  assert.deepEqual(phase({ programs: { cli: { state: "failed", hash: HASH, reason: "no bin dir" } } }), { step: "failed", reason: "Couldn't add ardia to your PATH: no bin dir" });
  assert.deepEqual(phase({ programs: { cli: { state: "linked", hash: HASH, linked: [], refused: { ardia: "taken by another app" }, binDir: "/b" } } }), { step: "failed", reason: "Couldn't add ardia to your PATH: taken by another app" });
  assert.deepEqual(phase({}, "ardia", "Couldn't download it. Try again."), { step: "failed", reason: "Couldn't download it. Try again." });
  assert.equal(phase({ fetches: { cli: { state: "promoting" } } }, "ardia", "old failure").step, "installing", "a retry under way hides the last failure");
});

test("Return presses the default button, unless it's disabled or a modifier is down", () => {
  const selectedCancel = consentKeyDown(FRESH_CONSENT_KEYS, { key: "Tab" }, true).state;
  assert.equal(consentKeyDown(selectedCancel, { key: "Enter" }, true).press, "install", "Return installs even with Cancel focused, as on a Mac");
  assert.equal(consentKeyDown(FRESH_CONSENT_KEYS, { key: "Enter" }, false).press, null);
  for (const mod of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) assert.equal(consentKeyDown(FRESH_CONSENT_KEYS, { key: "Enter", [mod]: true }, true).press, null, mod);
});
