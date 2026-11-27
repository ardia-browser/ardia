import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { steadyRows } from "../omnibox/steadyRows.ts";

const source = readFileSync(new URL("./SplitEmptyState.tsx", import.meta.url), "utf8");

test("the empty split pane's typed rows go through the command bar's steady rows, held while the pointer is over them", () => {
  assert.match(source, /const \{ hovered: overRows, hoverProps: rowsHover \} = useHover\(\);/);
  assert.match(source, /const items = useSteadyRows\(fitted, text, overRows, suggestionKey\)\.value\.items;/);
  assert.match(source, /<View \{\.\.\.rowsHover\}>\s*\{items\.map\(/);
});

test("a provider row that arrives above the remote suggestions while the pointer is over them leaves the row under the pointer where it is", () => {
  const key = (row) => row.id;
  const typed = { id: "search:maps" };
  const remote = { id: "search:maps near me" };
  const provider = { id: "provider:maps" };
  const shown = steadyRows(null, { items: [typed, remote] }, "maps", false, key);
  const held = steadyRows(shown, { items: [typed, provider, remote] }, "maps", true, key);
  assert.deepEqual(held.value.items, [typed, remote]);
  assert.deepEqual(steadyRows(held, { items: [typed, provider, remote] }, "maps", false, key).value.items, [typed, provider, remote]);
});
