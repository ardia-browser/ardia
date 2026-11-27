import { act } from "react-test-renderer";
import * as browse from "../state/browse/store";
import { startLinks } from "../state/links/links";
import { withTabs } from "../../test/render/harness";

const mockLinks = { listener: null as null | ((link: unknown) => void), initial: (_link: unknown) => undefined as void };

jest.mock("../platform/links", () => ({
  initialLink: () => new Promise((done) => (mockLinks.initial = done)),
  addLinkListener: (listener: (link: unknown) => void) => {
    mockLinks.listener = listener;
    return { remove: () => undefined };
  },
  setHidesFromRecents: async () => undefined,
}));

test("a link from another app that arrives while Ardia starts, then waits past Ardia leaving the screen, opens without returning to that app", async () => {
  jest.useFakeTimers();
  withTabs(1);
  const plain = jest.spyOn(browse, "openPage").mockImplementation(() => ({ id: "late" }) as ReturnType<typeof browse.openPage>);
  const handedOver = jest.spyOn(browse, "openPageFromAnotherApp").mockImplementation(() => undefined);
  await act(async () => startLinks());
  act(() => mockLinks.listener!({ kind: "open", url: "https://x.com/jack/status/20", source: "web" }));
  act(() => browse.appWillResignActive());
  act(() => browse.appBecameActive());
  act(() => mockLinks.listener!({ kind: "open", url: "https://x.com/jack/status/21", source: "web" }));
  await act(async () => mockLinks.initial(null));
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  expect(plain.mock.calls.map((call) => call[0])).toEqual(["https://x.com/jack/status/20"]);
  expect(handedOver.mock.calls.map((call) => call[0])).toEqual(["https://x.com/jack/status/21"]);
  jest.useRealTimers();
});
