import { Platform, processColor } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import Svg from "react-native-svg";

jest.mock("@ardia/phone-native", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return {
    ...jest.requireActual<object>("@ardia/phone-native"),
    nativeSymbolsAvailable: () => true,
    nativeSymbolExists: () => true,
    NativeSymbol: (props: object) => createElement("ArdiaPhoneSymbolView", props),
  };
});

const { Symbol, SystemGlyph, DesignProvider } = require("../components/ui") as typeof import("../components/ui");

const render = (node: React.ReactNode) => {
  let root: ReactTestRenderer | null = null;
  act(() => {
    root = create(<DesignProvider design="redesigned">{node}</DesignProvider>);
  });
  return root!;
};

const nativeGlyphs = (root: ReactTestRenderer) => root.root.findAll((node) => node.type === ("ArdiaPhoneSymbolView" as never));

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

onIos("on iPhone a mapped icon is Apple's SF Symbol, sized to the icon's box and keeping a translucent colour's alpha", () => {
  const root = render(<Symbol name="squareAndArrowUp" size={20} color="rgba(0,0,0,0.5)" weight="medium" />);
  const [glyph] = nativeGlyphs(root);
  expect(glyph!.props).toMatchObject({ name: "square.and.arrow.up", pointSize: 20 * 0.78, weight: "medium", color: processColor("rgba(0,0,0,0.5)"), style: { width: 20, height: 20 } });
  expect(root.root.findAll((node) => node.type === Svg)).toHaveLength(0);
});

onIos("on iPhone the incognito eyes stay drawn, since no SF Symbol shows them", () => {
  const root = render(<Symbol name="eyes" size={20} color="#000" />);
  expect(nativeGlyphs(root)).toHaveLength(0);
  expect(root.root.findAll((node) => node.type === Svg)).toHaveLength(1);
});

onIos("SystemGlyph draws through the same light native view and keeps its fitted box", () => {
  const root = render(<SystemGlyph systemName="chevron.down" pointSize={12} weight="semibold" fitted name="chevronDown" size={20} color="#333" />);
  expect(nativeGlyphs(root)[0]!.props).toMatchObject({ name: "chevron.down", pointSize: 12, weight: "semibold", style: { width: 12, height: 12 } });
});

onAndroid("Android keeps its drawn icons", () => {
  const root = render(<Symbol name="plus" size={20} color="#000" />);
  expect(nativeGlyphs(root)).toHaveLength(0);
  expect(root.root.findAll((node) => node.type === Svg)).toHaveLength(1);
});
