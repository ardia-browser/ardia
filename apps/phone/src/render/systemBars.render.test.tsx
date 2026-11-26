import { Platform, StatusBar } from "react-native";
import { setSystemBarIcons } from "../platform/systemBars";

const iosTest = Platform.OS === "ios" ? test : test.skip;

iosTest("a theme change sets the status bar's style in the same frame as the rest of the app, with no fade, as the Mac switches at once", () => {
  const set = jest.spyOn(StatusBar, "setBarStyle").mockImplementation(() => undefined);
  setSystemBarIcons(true, true);
  setSystemBarIcons(false, false);
  expect(set.mock.calls).toEqual([
    ["light-content", false],
    ["dark-content", false],
  ]);
  set.mockRestore();
});
