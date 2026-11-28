import { AppState, type AppStateStatus } from "react-native";
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

test("a link from another app that waits behind other link work until after Ardia has left the screen opens without returning to that app", async () => {
  jest.useFakeTimers();
  withTabs(1);
  const appState: ((next: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    appState.push(listener as (next: AppStateStatus) => void);
    return { remove: () => undefined };
  });
  const becomes = (next: AppStateStatus) => {
    for (const listener of appState) listener(next);
  };
  const plain = jest.spyOn(browse, "openPage").mockImplementation(() => ({ id: "late" }) as ReturnType<typeof browse.openPage>);
  const handedOver = jest.spyOn(browse, "openPageFromAnotherApp").mockImplementation(() => undefined);
  act(() => startLinks());
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  act(() => mockLinks.listener!({ kind: "inbox", source: "system" }));
  act(() => mockLinks.listener!({ kind: "open", url: "https://x.com/jack/status/20", source: "web" }));
  act(() => becomes("background"));
  await act(async () => mockInbox.finish(0));
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  expect(handedOver).not.toHaveBeenCalled();
  expect(plain).toHaveBeenCalledTimes(1);
  expect(plain.mock.calls[0]?.[0]).toBe("https://x.com/jack/status/20");
  act(() => becomes("active"));
  act(() => mockLinks.listener!({ kind: "open", url: "https://x.com/jack/status/21", source: "web" }));
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  expect(handedOver).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});
