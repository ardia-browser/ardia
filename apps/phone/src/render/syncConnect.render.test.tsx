import { SyncConnect } from "../components/sync/SyncConnect";
import { pressButton, renderSurface, textOf, unmount } from "../../test/render/harness";

const picks = { picked: 0, forgotten: [] as string[] };

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  return {
    ...actual,
    sync: {
      ...actual.sync,
      canPickFolderFirst: () => true,
      pickFolder: async () => {
        picks.picked += 1;
        return { folder: "content://sync", name: "Ardia Sync" };
      },
      connect: async () => ({ result: "invalidPhrase", problem: "Check the words." }),
      forgetFolder: async (folder: { folder: string }) => {
        picks.forgotten.push(folder.folder);
      },
    },
  };
});

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("the connect screen picks the sync folder first, shows its name, and forgets it when left unused", async () => {
  const root = renderSurface(<SyncConnect onClose={() => undefined} onConnected={() => undefined} />);
  expect(textOf(root)).toContain("Choose Folder…");
  await pressButton(root, "Choose Folder…");
  expect(picks.picked).toBe(1);
  expect(textOf(root)).toContain("Ardia Sync");
  expect(textOf(root)).toContain("Choose Another Folder…");
  unmount(root);
  expect(picks.forgotten).toEqual(["content://sync"]);
});
