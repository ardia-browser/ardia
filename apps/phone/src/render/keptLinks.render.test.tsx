import { act } from "react-test-renderer";
import { bootApp, retryImport, useBoot } from "../state/app/boot";
import * as browse from "../state/browse/store";
import { startLinks } from "../state/links/links";
import { readPreferences } from "../state/store/browserDatabase";
import { browserDatabase } from "../state/store/database";
import { withTabs } from "../../test/render/harness";

const mockImport = { resolve: (_result: unknown) => undefined as void };
const mockLinks = { listener: null as null | ((link: unknown) => void) };

jest.mock("../state/legacy/upgrade", () => ({
  importOldApp: () => new Promise((done) => (mockImport.resolve = done)),
  startWithoutOldApp: async () => false,
  offersStartWithout: () => false,
}));

jest.mock("../platform/links", () => ({
  initialLink: async () => null,
  addLinkListener: (listener: (link: unknown) => void) => {
    mockLinks.listener = listener;
    return { remove: () => undefined };
  },
  setHidesFromRecents: async () => undefined,
}));

test("a link sent while the import failure screen is up is kept in the store, then opens once after a later import succeeds", async () => {
  jest.useFakeTimers();
  const opened = jest.spyOn(browse, "openPage").mockImplementation(() => undefined);
  withTabs(1);
  act(() => bootApp(() => startLinks()));
  await act(async () => mockImport.resolve({ kind: "failed", reason: "source" }));
  expect(useBoot.getState()).toMatchObject({ ready: false, failures: 1 });
  act(() => mockLinks.listener!({ kind: "open", url: "https://example.com/held", source: "web" }));
  expect(JSON.parse(readPreferences(browserDatabase())["links.kept"]!)).toEqual([{ kind: "open", url: "https://example.com/held", source: "web" }]);
  expect(opened).not.toHaveBeenCalled();
  act(() => retryImport());
  await act(async () => mockImport.resolve({ kind: "ready", outcome: "imported" }));
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  expect(opened).toHaveBeenCalledTimes(1);
  expect(opened.mock.calls[0]?.[0]).toBe("https://example.com/held");
  expect(readPreferences(browserDatabase())["links.kept"]).toBeUndefined();
  opened.mockRestore();
  jest.useRealTimers();
});
