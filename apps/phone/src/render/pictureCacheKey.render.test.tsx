import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { TabFace } from "../components/ui/TabFace";
import { colorRoles } from "../components/ui/tokens";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

test("a page's picture draws at its own size, so on Android the decoded bitmap pages.snapshot() holds in Fresco's cache under its file uri is the one the card shows, with no read or decode", () => {
  withTabs(1);
  const tab = { ...currentTabs().open[0]!, snapshotFileName: "file:///pictures/t1-1.jpg" };
  const root = renderSurface(<TabFace tab={tab} title="Example" host="example.com" tone={null} roles={colorRoles.light} />);
  const images = root.root.findAll((node) => typeof node.type === "string" && node.props.source?.uri === "file:///pictures/t1-1.jpg");
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) expect(image.props.resizeMethod).toBe("scale");
  unmount(root);
});

test("a second face for a picture already shown draws it at its own shape from its first frame, never cover-fit while the shape loads, so the opening card can't flash a cropped page", () => {
  withTabs(1);
  const tab = { ...currentTabs().open[0]!, snapshotFileName: "file:///pictures/t1-shape.jpg" };
  const image = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => typeof node.type === "string" && node.props.source?.uri === "file:///pictures/t1-shape.jpg")[0]!;
  const deck = renderSurface(<TabFace tab={tab} title="Example" host="example.com" tone={null} roles={colorRoles.light} />);
  expect(StyleSheet.flatten(image(deck).props.style).aspectRatio).toBeUndefined();
  act(() => image(deck).props.onLoad({ nativeEvent: { source: { width: 600, height: 1176 } } }));
  expect(StyleSheet.flatten(image(deck).props.style).aspectRatio).toBeCloseTo(600 / 1176, 6);
  const opening = renderSurface(<TabFace tab={tab} title="Example" host="example.com" tone={null} roles={colorRoles.light} />, { flushTimers: false });
  expect(StyleSheet.flatten(image(opening).props.style).aspectRatio).toBeCloseTo(600 / 1176, 6);
  unmount(opening);
  unmount(deck);
});
