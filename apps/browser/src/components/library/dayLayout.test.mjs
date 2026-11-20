import assert from "node:assert/strict";
import { test } from "node:test";

const { dayLayout, firstSlotEndingAfter, firstSlotStartingAfter } = await import("./dayLayout.ts");

const LIST = { columns: 1, header: 28, untitledGap: null, row: 30, rowGap: 0, endPad: 8 };
const CARDS = { columns: 3, header: 28, untitledGap: 8, row: 92, rowGap: 8, endPad: 8 };

function placedBefore(groups, keyOf, m) {
  const placed = [];
  let top = 0;
  for (const group of groups) {
    if (group.title || m.untitledGap === null) {
      placed.push({ key: `h${group.key}`, pool: "h", top, height: m.header, item: { kind: "header", title: group.title } });
      top += m.header;
    } else top += m.untitledGap;
    for (let i = 0; i < group.items.length; i += m.columns) {
      const items = group.items.slice(i, i + m.columns);
      placed.push({ key: items.map(keyOf).join("|"), pool: "r", top, height: m.row, item: { kind: "row", items } });
      top += m.row + m.rowGap;
    }
  }
  return { placed, height: top + m.endPad };
}

const groupsOf = (sizes, titled = true) => {
  let n = 0;
  return sizes.map((size, g) => ({ key: String(g), title: titled ? `Day ${g}` : "", items: Array.from({ length: size }, () => ({ url: `https://e/${n++}` })) }));
};
const keyOf = (item) => item.url;

test("every slot, key and height matches laying out each row one by one", () => {
  for (const [sizes, m, titled] of [[[1, 5, 2, 7], LIST, true], [[1, 5, 2, 7, 3, 4], CARDS, true], [[8], CARDS, false], [[4, 1], LIST, false]]) {
    const groups = groupsOf(sizes, titled);
    const layout = dayLayout(groups, keyOf, m);
    const before = placedBefore(groups, keyOf, m);
    assert.equal(layout.count, before.placed.length);
    assert.equal(layout.height, before.height);
    assert.deepEqual(Array.from({ length: layout.count }, (_, i) => layout.at(i)), before.placed);
  }
});

test("each entry is one cursor key in order, and its slot holds it, across day seams", () => {
  const groups = groupsOf([1, 5, 2, 7, 3, 4]);
  const flat = groups.flatMap((g) => g.items);
  for (const m of [LIST, CARDS]) {
    const layout = dayLayout(groups, keyOf, m);
    assert.equal(layout.keys.length, flat.length);
    flat.forEach((item, i) => {
      assert.equal(layout.keys.at(i), item.url);
      assert.equal(layout.keys.indexOf(item.url), i);
      assert.equal(layout.itemAt(i), item);
      assert.equal(layout.itemOf(item.url, i), item);
      assert.equal(layout.itemOf(item.url, i + 1), item, "a stale hint still finds the entry");
      const slot = layout.at(layout.slotOfItem(i));
      assert.equal(slot.item.kind, "row");
      assert.ok(slot.item.items.includes(item));
    });
    assert.equal(layout.keys.at(flat.length), undefined);
    assert.equal(layout.keys.indexOf("https://e/missing"), -1);
  }
});

test("the visible range finds the slots that overlap a scroll window", () => {
  const groups = groupsOf([3, 9, 2]);
  const layout = dayLayout(groups, keyOf, LIST);
  const all = Array.from({ length: layout.count }, (_, i) => layout.at(i));
  for (const y of [0, 27, 28, 57, 58, 100, 333, layout.height]) {
    assert.equal(firstSlotEndingAfter(layout, y), all.findIndex((s) => s.top + s.height > y) === -1 ? all.length : all.findIndex((s) => s.top + s.height > y));
    const starting = all.findIndex((s) => s.top >= y);
    assert.equal(firstSlotStartingAfter(layout, y), starting === -1 ? all.length : starting);
  }
});

test("laying out 100,000 entries reads no entry until a slot is asked for", () => {
  const groups = groupsOf(Array.from({ length: 400 }, () => 250));
  let reads = 0;
  const layout = dayLayout(groups, (item) => (reads++, item.url), CARDS);
  assert.equal(reads, 0);
  assert.equal(layout.keys.length, 100_000);
  layout.at(firstSlotEndingAfter(layout, 50_000));
  assert.ok(reads < 200, `${reads} keys read to find one slot`);
});

test("the item at the top of a slot maps back to that slot, so a list and its cards open at the same item", () => {
  for (const m of [LIST, CARDS]) {
    const layout = dayLayout(groupsOf([4, 7, 1, 5]), keyOf, m);
    for (let item = 0; item < 17; item++) {
      const slot = layout.slotOfItem(item);
      const top = layout.itemOfSlot(slot);
      assert.ok(top <= item && item < top + m.columns, `item ${item} sits in the row that starts at ${top}`);
      assert.equal(layout.slotOfItem(top), slot);
    }
    assert.equal(layout.itemOfSlot(0), 0, "a header slot maps to its day's first item");
  }
  assert.equal(dayLayout([], keyOf, LIST).itemOfSlot(0), -1);
});
