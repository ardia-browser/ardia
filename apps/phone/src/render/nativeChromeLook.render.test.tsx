import { chromeLookBridge, nativeChromeUsesGlass, usePublishNativeChromeLook } from "../components/settings/nativeChromeLook";
import * as look from "../components/ui/LookViews";
import * as appearance from "../state/settings/appearance";
import { renderSurface, unmount, updateSurface } from "../../test/render/harness";

beforeEach(() => jest.useFakeTimers());

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function Publisher() {
  usePublishNativeChromeLook();
  return null;
}

test("native Summary and Research hear the same Glass or Classic decision the Settings sheet takes, and again when it changes", () => {
  const published = jest.fn();
  jest.spyOn(chromeLookBridge, "module").mockReturnValue({ setChromeUsesGlass: published });
  jest.spyOn(look, "usesGlass").mockReturnValue(true);
  const style = jest.spyOn(appearance, "useChromeStyle").mockReturnValue("glass");
  const root = renderSurface(<Publisher />);
  expect(published.mock.calls).toEqual([[true]]);
  style.mockReturnValue("classic");
  updateSurface(root, <Publisher />);
  expect(published.mock.calls).toEqual([[true], [false]]);
  unmount(root);
});

test("Classic, Reduce Transparency (which the chrome style already folds in) and a phone without native glass all mean solid", () => {
  expect(nativeChromeUsesGlass("glass", true)).toBe(true);
  expect(nativeChromeUsesGlass("classic", true)).toBe(false);
  expect(nativeChromeUsesGlass("glass", false)).toBe(false);
});
