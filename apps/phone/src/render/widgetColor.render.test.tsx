const calls: (string | null)[] = [];

jest.mock("../platform/system", () => ({ ...jest.requireActual("../platform/system"), setWidgetColorChoice: (choice: string | null) => calls.push(choice) }));

const { followColorInWidgets } = require("../state/settings/widgetColor") as typeof import("../state/settings/widgetColor");
const { setColorChoice } = require("../state/settings/actions") as typeof import("../state/settings/actions");
const { usePreferences } = require("../state/settings/store") as typeof import("../state/settings/store");

test("the widgets get the Color setting once at launch and again whenever it changes, as Compose's ProfileLook reads it", () => {
  usePreferences.setState({ colorChoice: null });
  const stop = followColorInWidgets();
  expect(calls).toEqual([null]);
  setColorChoice("green");
  setColorChoice("green");
  usePreferences.setState({ searchSuggestions: !usePreferences.getState().searchSuggestions });
  expect(calls).toEqual([null, "green"]);
  stop();
  setColorChoice("plum");
  expect(calls).toEqual([null, "green"]);
});
