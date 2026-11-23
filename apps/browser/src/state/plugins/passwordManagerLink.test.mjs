import assert from "node:assert/strict";
import { test } from "node:test";
const { showPasswordManagerSettings, passwordManagerAnchor } = await import("./passwordManagerLink.ts");
const { useSettingsNav } = await import("../settings/settingsWindows.ts");
const { useSettingsSearch } = await import("../settings/searchState.ts");

test("a password manager's plugin page goes to the profile's Passwords page and lights that manager's row", () => {
  useSettingsNav.setState({ pane: "plugins", profileId: null, detail: "bitwarden", back: [], forward: [] });
  showPasswordManagerSettings("bitwarden");
  const nav = useSettingsNav.getState();
  assert.deepEqual([nav.pane, nav.detail], ["profiles", "passwords"]);
  assert.deepEqual(nav.back.at(-1), { pane: "plugins", profileId: null, detail: "bitwarden" }, "Back returns to the plugin page");
  assert.equal(useSettingsSearch.getState().flash?.id, passwordManagerAnchor("bitwarden"));
});
