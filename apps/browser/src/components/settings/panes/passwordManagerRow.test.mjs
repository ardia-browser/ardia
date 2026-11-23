import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

await import("../../../test-native/index.ts");
const { managerPopUp, unavailableNote } = await import("./PasswordManagerRow.tsx");

const MANAGER = { name: "password-manager", title: "Test Passwords", spec: { fill: "system", fields: ["login"] }, builtIn: true, approval: "h" };

test("a stored plugin that is off shows as its own option, so picking Ardia is a change that gets saved", () => {
  const popUp = managerPopUp([], "plugin:password-manager", "ardia", { title: "Test Passwords", installed: true });
  assert.equal(popUp.value, "plugin:password-manager");
  assert.deepEqual(
    popUp.options.map((o) => [o.value, o.title]),
    [
      ["ardia", "Ardia"],
      ["plugin:password-manager", "Test Passwords (off)"],
      ["none", "None (an extension handles logins)"],
    ],
  );
  assert.notEqual(popUp.value, "ardia");
});

test("an available choice shows as itself with no extra option", () => {
  const on = managerPopUp([MANAGER], "plugin:password-manager", "plugin:password-manager", { title: "Test Passwords", installed: true });
  assert.equal(on.value, "plugin:password-manager");
  assert.equal(on.options.length, 3);
  const ardia = managerPopUp([MANAGER], "ardia", "ardia", null);
  assert.equal(ardia.value, "ardia");
  assert.equal(ardia.options.length, 3);
  const never = managerPopUp([MANAGER], undefined, "plugin:password-manager", null);
  assert.equal(never.value, "plugin:password-manager");
  assert.equal(never.options.length, 3);
});

test("a stored plugin that was removed says it isn't installed, never to turn it on in Plugins", () => {
  const gone = { title: "old-passwords", installed: false };
  assert.match(unavailableNote("plugin:old-passwords", "ardia", gone), /isn't installed/);
  assert.doesNotMatch(unavailableNote("plugin:old-passwords", "ardia", gone), /turn it back on/);
  assert.equal(managerPopUp([], "plugin:old-passwords", "ardia", gone).options[1].title, "old-passwords (not installed)");
  assert.match(unavailableNote("plugin:password-manager", "ardia", { title: "Test Passwords", installed: true }), /is off/);
  assert.equal(unavailableNote("plugin:password-manager", "plugin:password-manager", { title: "Test Passwords", installed: true }), null);
});

test("Ardia names the password managers it fills from, in the row's value and in the menu, so a manager is never hunted for as its own choice", async () => {
  const { managersOn } = await import("../../../state/vaults/ardiaSources.ts");
  const provider = (id, name, state, unavailable) => ({ id, name, state, ...(unavailable ? { unavailable } : {}) });
  const providers = [
    provider("ardia", "Ardia", "unlocked"),
    provider("1password", "1Password", "unlocked"),
    provider("bitwarden", "Bitwarden", "signedOut"),
    provider("protonpass", "Proton Pass", "unavailable", { reason: "off", canRestart: false }),
  ];
  const on = managersOn(providers).map((p) => p.name);
  assert.deepEqual(on, ["1Password", "Bitwarden"], "a signed-out manager is still a source; one turned off isn't");
  const title = (sources) => managerPopUp([], "ardia", "ardia", null, sources).options[0].title;
  assert.equal(title([]), "Ardia");
  assert.equal(title(["1Password"]), "Ardia · 1Password");
  assert.equal(title(["1Password", "Bitwarden", "Proton Pass"]), "Ardia · 1Password, Bitwarden, Proton Pass");
  assert.equal(managerPopUp([], "ardia", "ardia", null, ["1Password"]).options.at(-1).title, "None (an extension handles logins)");
});
