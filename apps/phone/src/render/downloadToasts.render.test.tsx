import { act } from "react-test-renderer";
import { ToastHost } from "../components/toasts/ToastHost";
import { downloads } from "../platform/downloads";
import { pages } from "../platform/pages";
import * as browse from "../state/browse/store";
import { startPageUi } from "../state/page/actions";
import { useToasts } from "../state/toasts/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

type Listener = (event: { name: string; [key: string]: unknown }) => void;

const pageListeners: Listener[] = [];
const downloadListeners: Listener[] = [];

jest.spyOn(pages, "addListener").mockImplementation((listener: unknown) => {
  pageListeners.push(listener as Listener);
  return { remove: () => undefined } as never;
});
jest.spyOn(downloads, "addListener").mockImplementation((listener: unknown) => {
  downloadListeners.push(listener as Listener);
  return { remove: () => undefined } as never;
});

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  browse.startBrowser();
  startPageUi();
  useToasts.setState({ toast: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const page = (fields: Record<string, unknown>) =>
  act(() => pageListeners.forEach((listener) => listener({ name: "page.download", pageId: "t0", url: "https://files.example/otter.pdf", fileName: "otter.pdf", mimeType: "application/pdf", contentLength: 10, isPrivate: false, ...fields })));
const finished = (fields: Record<string, unknown>) => act(() => downloadListeners.forEach((listener) => listener({ name: "downloads.finished", fileName: "otter.pdf", uri: null, ...fields })));

const symbolShown = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => typeof node.props.name === "string" && typeof node.props.size === "number" && typeof node.type !== "string").map((node) => node.props.name as string);

test("a download the system took says Downloading with the filled arrow; one it refused at the start says it couldn't, with the filled warning", () => {
  const root = renderSurface(<ToastHost />);
  page({ downloadId: "17" });
  expect(useToasts.getState().toast).toMatchObject({ message: "Downloading otter.pdf", icon: "download" });
  expect(symbolShown(root)).toContain("arrowDownCircleFill");
  page({ downloadId: null, fileName: "seal.zip" });
  expect(useToasts.getState().toast).toMatchObject({ message: "Couldn’t Download seal.zip", icon: "warning" });
  expect(symbolShown(root)).toContain("exclamationmarkTriangleFill");
  unmount(root);
});

test("ending incognito with three private downloads in flight gives one toast for all of them, as Compose's", () => {
  const shown = jest.fn();
  const unsubscribe = useToasts.subscribe((state) => state.toast && shown(state.toast.message));
  for (let index = 0; index < 3; index++) finished({ fileName: `private-${index}.zip`, failure: "privateSessionEnded" });
  act(() => jest.advanceTimersByTime(300));
  expect(shown.mock.calls.map(([message]) => message)).toEqual(["Stopped 3 Private Downloads"]);
  expect(useToasts.getState().toast?.icon).toBe("warning");
  finished({ failure: "network" });
  expect(useToasts.getState().toast?.message).toBe("Couldn’t Download otter.pdf");
  unsubscribe();
});
