import { act } from "react-test-renderer";
import { DesignProvider, usePageTheme, useTheme, type Theme } from "../components/ui";
import { IncognitoLook } from "../components/ui/theme";
import type { Design } from "../lib/design";
import { setAppearanceDesign, usePageDark } from "../state/settings/appearance";
import { usePreferences } from "../state/settings/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("../platform/look", () => ({ ...jest.requireActual("../platform/look"), overrideColorScheme: () => undefined, overridePageScheme: () => Promise.resolve(null) }));

let page: Theme | null = null;
let app: Theme | null = null;

function Probe() {
  page = usePageTheme();
  app = useTheme();
  return null;
}

function seen(design: Design, scheme: "light" | "dark", pageDark: boolean, incognito = false) {
  act(() => {
    setAppearanceDesign(design);
    usePreferences.setState({ schemeChoice: scheme, colorChoice: null });
    usePageDark.setState({ dark: pageDark });
  });
  const root = renderSurface(
    <DesignProvider design={design}>
      <IncognitoLook value={incognito}>
        <Probe />
      </IncognitoLook>
    </DesignProvider>,
  );
  const shown = { page: page!, app: app! };
  unmount(root);
  return shown;
}

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  act(() => {
    usePageDark.setState({ dark: null });
    setAppearanceDesign("original");
  });
});

test("Material You draws a dark page's stand-ins from the dark palette while the app is still light", () => {
  const lightApp = seen("material", "light", true);
  const darkApp = seen("material", "dark", true);
  expect(lightApp.app.dark).toBe(false);
  expect(lightApp.page.dark).toBe(true);
  expect(lightApp.page.canvas).toBe(darkApp.app.canvas);
  expect(lightApp.page.foregroundPrimary).toBe(darkApp.app.foregroundPrimary);
});

test("Material You draws a light page's stand-ins from the light palette while the app is still dark", () => {
  const darkApp = seen("material", "dark", false);
  const lightApp = seen("material", "light", false);
  expect(darkApp.page.dark).toBe(false);
  expect(darkApp.page.canvas).toBe(lightApp.app.canvas);
});

test("Incognito's forced dark stays in the app; a page shown light keeps a light stand-in", () => {
  const incognito = seen("redesigned", "light", false, true);
  const plain = seen("redesigned", "light", false);
  expect(incognito.app.dark).toBe(true);
  expect(incognito.page.dark).toBe(false);
  expect(incognito.page.canvas).toBe(plain.page.canvas);
});
