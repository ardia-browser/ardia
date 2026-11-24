import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a sidebar page provides its drag items from its own hooks, with no component of its own", () => {
  const provider = read("./DragProvider.tsx");
  const page = read("./SidebarPage.tsx");
  assert.doesNotMatch(provider, /export function DragPage\b/);
  assert.match(provider, /export function useDragPage\(live: boolean\) \{\n  const controller = useContext\(DragContext\);\n  const items = useMemo\(\(\) => controller && new DragItems\(controller, false\), \[controller\]\);\n  useLayoutEffect\(\(\) => items\?\.setLive\(live\), \[items, live\]\);/);
  assert.doesNotMatch(page, /<DragPage\b/);
  assert.match(page, /const windowId = useWindowId\(\);\n  const dragPage = useDragPage\(current\);/, "declared before the page's other layout effects, so the items go live first as they did from the child");
  assert.match(page, /<SidebarInk>\n {12}\{dragPage\(\n {14}<>/);
});
