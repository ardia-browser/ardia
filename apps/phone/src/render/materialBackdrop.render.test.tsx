import { DeckBackdrop, Frost, ProfileBackdrop } from "@ardia/phone-native";
import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { Backdrop } from "../components/ui/Backdrop";
import { DeckLookBackdrop, LookBackdrop, LookFrost } from "../components/ui/LookViews";
import { DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import { renderSurface, unmount, withTabs, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");
const onAndroid = Platform.OS === "android" ? test : test.skip;
const TEAL = SEEDED_SCHEMES.green;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  setDynamicScheme({ light: TEAL.light, dark: TEAL.dark });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  setDynamicScheme(null);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const material = (node: React.ReactElement) => renderSurface(<DesignProvider design="material">{node}</DesignProvider>);

onAndroid("in the material design the start and deck backdrops are the wallpaper scheme's surfaces, never the profile look the native backdrop paints", () => {
  const start = material(<LookBackdrop themed />);
  expect(start.root.findAll((found) => found.type === ProfileBackdrop)).toHaveLength(0);
  expect(start.root.findAll((found) => found.type === Backdrop)[0]!.props.colors).toEqual([TEAL.light.surface, TEAL.light.surfaceContainerLow]);
  unmount(start);
  const deck = material(<DeckLookBackdrop />);
  expect(deck.root.findAll((found) => found.type === DeckBackdrop)).toHaveLength(0);
  expect(deck.root.findAll((found) => found.type === Backdrop)[0]!.props.colors).toEqual([TEAL.light.surface, TEAL.light.surface]);
  unmount(deck);
  const frost = material(<LookFrost source="surfaces" variant={"regular" as never} cornerRadius={12} fill={TEAL.light.surfaceContainer} />);
  expect(frost.root.findAll((found) => found.type === Frost)).toHaveLength(0);
  unmount(frost);
});

onAndroid("the original design keeps the native profile backdrop", () => {
  const root = renderSurface(
    <DesignProvider design="original">
      <LookBackdrop themed />
    </DesignProvider>,
  );
  expect(root.root.findAll((found) => found.type === ProfileBackdrop)).toHaveLength(1);
  unmount(root);
});
