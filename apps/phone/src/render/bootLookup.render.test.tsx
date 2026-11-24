import { act } from "react-test-renderer";

const mockImport = { calls: 0 };

jest.mock("../state/store/database", () => ({
  ...jest.requireActual<object>("../state/store/database"),
  browserDatabaseIsDurable: () => {
    throw new Error("the browser database could not be opened");
  },
}));
jest.mock("../platform/legacy", () => ({ ...jest.requireActual<object>("../platform/legacy"), nativeImportState: () => "none" }));
jest.mock("../state/legacy/upgrade", () => ({
  importOldApp: async () => {
    mockImport.calls += 1;
    return { kind: "failed", reason: "write" };
  },
  startWithoutOldApp: async () => false,
  offersStartWithout: () => true,
}));

test("a browser database that can't be read at launch goes through the import attempt and its failure screen, never straight into the browser", async () => {
  const { bootApp, useBoot } = require("../state/app/boot") as typeof import("../state/app/boot");
  const start = jest.fn();
  await act(async () => bootApp(start));
  expect(start).not.toHaveBeenCalled();
  expect(mockImport.calls).toBe(1);
  expect(useBoot.getState()).toMatchObject({ ready: false, failures: 1 });
});
