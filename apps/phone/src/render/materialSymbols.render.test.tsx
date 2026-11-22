import { Platform } from "react-native";
import Svg, { Path } from "react-native-svg";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import artwork from "../../assets/material-symbols.json";
import { materialSymbolFor } from "../components/ui/MaterialSymbol";
import { Symbol } from "../components/ui/Symbol";
import { SYMBOLS, type SymbolName } from "../components/ui/symbolPaths";
import { withMaterialYou } from "../../test/render/harness";

withMaterialYou();

test.each(Object.keys(SYMBOLS) as SymbolName[])("%s uses Material artwork only on Android with Material You on, and keeps Ardia's own artwork", (name) => {
  let root!: ReactTestRenderer;
  act(() => { root = create(<Symbol name={name} size={22} color="#123456" />); });
  const shared = materialSymbolFor(name);
  const material = Platform.OS === "android" && shared !== null;
  const icon = shared ? artwork.icons[artwork.javascript[shared] as keyof typeof artwork.icons] : undefined;
  const paths = root.root.findAll((node) => node.type === Path);
  expect(root.root.findAll((node) => node.type === Svg)[0]!.props).toMatchObject({ width: 22, height: 22, viewBox: material ? icon!.viewBox : "0 0 24 24" });
  expect(paths.map((path) => path.props.d)).toEqual(material ? icon!.paths : SYMBOLS[name].map((layer) => layer.d));
  if (material) for (const path of paths) expect(path.props.fill).toBe("#123456");
  act(() => root.unmount());
});
