import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
globalThis.require ??= (id) => ({ asset: id });
await import("../../test-native/index.ts");
const ts = (await import("typescript")).default;
const { requestCreateProfile, useCreateProfileRequest } = await import("../../state/profiles/createProfileRequest.ts");
const { useSettingsSheet } = await import("../../state/settings/sheet.ts");
const { showCreateProfileSheets } = await import("./CreateProfile.tsx");

after(() => {
  useCreateProfileRequest.setState({ request: null, sheet: null });
  useSettingsSheet.setState({ sheet: null });
});

const shownPreset = () => useSettingsSheet.getState().sheet?.props.preset;
const finishShown = (id) => useSettingsSheet.getState().sheet.props.onDone(id);

test("Settings › Profiles' + asks for a profile with no window, and the Settings window shows the sheet for it (#4402)", async () => {
  const waiting = requestCreateProfile(undefined, { name: "Before" });
  assert.equal(useSettingsSheet.getState().sheet, null, "nothing shows it until the Settings window watches");
  const stop = showCreateProfileSheets();
  assert.deepEqual(shownPreset(), { name: "Before" }, "a request made before Settings opened shows once it does");
  assert.equal(useCreateProfileRequest.getState().sheet, null, "and is taken");
  finishShown("p-before");
  assert.equal(await waiting, "p-before");
  assert.equal(useSettingsSheet.getState().sheet, null, "finishing closes the sheet");

  const plus = requestCreateProfile();
  assert.deepEqual(shownPreset(), {}, "a + press while Settings is open shows the sheet at once");
  finishShown(null);
  assert.equal(await plus, null, "Cancel resolves with no profile");

  stop();
  void requestCreateProfile(undefined, { name: "Closed" });
  assert.equal(useSettingsSheet.getState().sheet, null, "a closed Settings window shows nothing");
  assert.deepEqual(useCreateProfileRequest.getState().sheet?.preset, { name: "Closed" }, "the request waits for the next one");
});

test("CreateProfile.tsx does nothing at load: Metro's inline requires load it only when it's first used", () => {
  const path = new URL("./CreateProfile.tsx", import.meta.url);
  const file = ts.createSourceFile("CreateProfile.tsx", readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects = file.statements.filter((s) => ts.isExpressionStatement(s)).map((s) => s.getText(file).slice(0, 60));
  assert.deepEqual(effects, []);
});

test("the Settings window watches for create-profile requests for as long as it's open", () => {
  const source = readFileSync(new URL("../settings/SettingsWindow.tsx", import.meta.url), "utf8");
  assert.match(source, /useEffect\(showCreateProfileSheets, \[\]\);/);
});
