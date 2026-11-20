import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { usePages } = await import("../tabs/pageState.ts");
const { startLiveEngine } = await import("./engine.ts");
const { createFolder, live, removeFolder, updateFolder } = await import("./store.ts");

let held = 0;
const subscribe = usePages.subscribe;
usePages.subscribe = Object.assign((listener) => {
  held++;
  const stop = subscribe(listener);
  let stopped = false;
  return () => {
    if (!stopped) held--;
    stopped = true;
    stop();
  };
}, subscribe);

useBrowser.getState().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
useBrowser.getState().createWindow({ url: "https://start.example/" });
startLiveEngine();
after(() => live().folderOrder.forEach(removeFolder));

test("the live engine watches pages only while a folder hides completed items", () => {
  assert.equal(held, 0, "no live folders");
  const id = createFolder("default", "pullRequests", ["github"]);
  assert.equal(held, 0, "a folder showing completed items needs no watch");
  updateFolder(id, { showCompleted: false });
  assert.equal(held, 1);
  updateFolder(id, { showCompleted: true });
  assert.equal(held, 0);
  updateFolder(id, { showCompleted: false });
  removeFolder(id);
  assert.equal(held, 0);
});
