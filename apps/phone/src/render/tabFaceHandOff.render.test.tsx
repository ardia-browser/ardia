import { act } from "react-test-renderer";
import { create } from "zustand";
import { TabFace } from "../components/ui/TabFace";
import { colorRoles } from "../components/ui/tokens";
import { noteSnapshotShown } from "../lib/shownSnapshots";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const LOADED = { nativeEvent: { source: { width: 600, height: 1300 } } };

type Root = ReturnType<typeof renderSurface>;

const usePicture = create<{ picture: string | null }>()(() => ({ picture: null }));

function Face() {
  const picture = usePicture((state) => state.picture);
  const tab = { ...currentTabs().open[0]!, title: "Kernel Archives", snapshotFileName: picture };
  return <TabFace tab={tab} title="Kernel Archives" host="kernel.org" tone={null} roles={colorRoles.light} />;
}

const face = (picture: string | null) => {
  usePicture.setState({ picture });
  return <Face />;
};

const show = (picture: string) => act(() => usePicture.setState({ picture }));

const images = (root: Root) => root.root.findAll((node) => typeof node.props.onLoad === "function" && typeof node.type !== "string");
const sources = (root: Root) => [...new Set(images(root).map((node) => node.props.source?.uri as string))];
const load = (root: Root, uri: string) => act(() => images(root).find((node) => node.props.source?.uri === uri)!.props.onLoad(LOADED));

test("a picture marked as seen but never loaded in this run still shows the tab's face until it has loaded, never the card's bare colour", () => {
  withTabs(1);
  const cold = "file:///snapshots/cold-seen.jpg";
  noteSnapshotShown(cold);
  const root = renderSurface(face(cold), { flushTimers: false });
  expect(textOf(root)).toContain("Kernel Archives");
  load(root, cold);
  act(() => jest.advanceTimersByTime(32));
  expect(textOf(root)).not.toContain("Kernel Archives");
  unmount(root);
});

test("when two newer pictures arrive before the first of them has loaded, the last loaded picture stays underneath until a newer one has loaded", () => {
  withTabs(1);
  const shownFirst = "file:///snapshots/hand-off-a.jpg";
  const second = "file:///snapshots/hand-off-b.jpg";
  const third = "file:///snapshots/hand-off-c.jpg";
  const root = renderSurface(face(shownFirst), { flushTimers: false });
  load(root, shownFirst);
  act(() => jest.advanceTimersByTime(200));
  show(second);
  expect(sources(root)).toEqual([shownFirst, second]);
  show(third);
  expect(sources(root)).toEqual([shownFirst, third]);
  load(root, third);
  for (let frame = 0; frame < 20; frame++) act(() => jest.advanceTimersByTime(16));
  expect(sources(root)).toEqual([third]);
  unmount(root);
});
