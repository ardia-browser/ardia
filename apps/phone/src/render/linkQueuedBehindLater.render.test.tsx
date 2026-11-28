import { act } from "react-test-renderer";
import * as browse from "../state/browse/store";
import { startLinks } from "../state/links/links";
import { withTabs } from "../../test/render/harness";

const mockLinks = { listener: null as null | ((link: unknown) => void) };
const mockInbox = { finish: (_opened: number) => undefined as void };

jest.mock("../platform/links", () => ({
  initialLink: async () => null,
  addLinkListener: (listener: (link: unknown) => void) => {
    mockLinks.listener = listener;
    return { remove: () => undefined };
  },
  setHidesFromRecents: async () => undefined,
}));

jest.mock("../state/sync/actions", () => ({
  ...jest.requireActual("../state/sync/actions"),
  applyInbox: () => new Promise<number>((done) => (mockInbox.finish = done)),
}));

test("a link from another app still waiting in the queue when a later link arrives opens without returning to its app", async () => {
  jest.useFakeTimers();
  withTabs(1);
  const plain = jest.spyOn(browse, "openPage").mockImplementation(() => ({ id: "earlier" }) as ReturnType<typeof browse.openPage>);
  const handedOver = jest.spyOn(browse, "openPageFromAnotherApp").mockImplementation(() => undefined);
  await act(async () => startLinks());
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  act(() => mockLinks.listener!({ kind: "inbox", source: "system" }));
  act(() => mockLinks.listener!({ kind: "open", url: "https://x.com/jack/status/20", source: "web" }));
  act(() => mockLinks.listener!({ kind: "search", query: null, source: "intent" }));
  await act(async () => mockInbox.finish(0));
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  expect(handedOver).not.toHaveBeenCalled();
  expect(plain.mock.calls.map((call) => call[0])).toEqual(["https://x.com/jack/status/20"]);
  act(() => mockLinks.listener!({ kind: "open", url: "https://x.com/jack/status/21", source: "web" }));
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  expect(handedOver.mock.calls.map((call) => call[0])).toEqual(["https://x.com/jack/status/21"]);
  jest.useRealTimers();
});
