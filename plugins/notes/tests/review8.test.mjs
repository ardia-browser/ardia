import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, until } from "./support/build.mjs";
import { block, makeRecords, memorySink, merge, pageTitled, recordsImport, textOf, u, zipImport, hex, addParagraph } from "./support/importWorld.mjs";

const M = await load();
const { Y, model } = M;
const DOC = "p-aaaaaaaaaaaa";

function storeAt(dir, deviceId) {
  const files = M.nodeFiles({ data: dir });
  const store = new M.WorkspaceStore({ fs: M.ardiaFileStore(files, "data", "ws1", { callMax: 8192 }), deviceId, debounceMs: 2, rescanMs: 0, compactAt: 1 });
  return { files, store };
}

const bigText = (seed) => Array.from({ length: 3000 }, (_, i) => `${seed}${(i * 7919) % 1000}`).join(" ");

test("4: a snapshot whose pointer reads but whose piece is still in iCloud stays unread until it's read whole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-review8-"));
  const bob = storeAt(dir, "bobdevice01");
  await bob.store.open();
  const bobDoc = await bob.store.get(DOC);
  bobDoc.getXmlFragment("blocks").insert(0, [new Y.XmlText(bigText("first"))]);
  await bob.store.whenIdle();
  const alice = storeAt(dir, "alicedevice1");
  await alice.store.open();
  const aliceDoc = await alice.store.get(DOC);
  assert.match(aliceDoc.getXmlFragment("blocks").toString(), /first/);
  bobDoc.getXmlFragment("blocks").insert(1, [new Y.XmlText(` second ${bigText("second")}`)]);
  await bob.store.whenIdle();
  alice.files.faults.read = (_root, path) => path.includes(".chunks-bobdevice01/");
  assert.equal(await alice.store.rescan(), true);
  assert.doesNotMatch(aliceDoc.getXmlFragment("blocks").toString(), /second/);
  assert.notDeepEqual(alice.store.waitingFor([DOC]), [], "the half-read snapshot is still waited on");
  assert.equal(await alice.store.rescan(), true);
  assert.notDeepEqual(alice.store.waitingFor([DOC]), [], "a second rescan doesn't forget it");
  alice.files.faults.read = undefined;
  assert.equal(await alice.store.rescan(), true);
  assert.match(aliceDoc.getXmlFragment("blocks").toString(), /second/);
  assert.deepEqual(alice.store.waitingFor([DOC]), []);
  alice.files.faults.list = () => true;
  assert.equal(await alice.store.rescan(), false, "a failed listing isn't a successful rescan");
  await alice.store.close();
  await bob.store.close();
  alice.files.detach();
  bob.files.detach();
});

function clearBody(doc) {
  const fragment = doc.getXmlFragment("blocks");
  doc.transact(() => fragment.delete(0, fragment.length));
}

test("1: a body cleared here stays cleared when Notion didn't change it, and counts a conflict when it did", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  clearBody(s.docs.get(home.id));
  const same = await recordsImport(s, makeRecords());
  assert.equal(textOf(s.docs.get(home.id)), "", "the cleared body stays cleared");
  assert.equal(same.conflicts, 0);
  const changed = await recordsImport(s, makeRecords({ body: "rewritten in notion" }));
  assert.equal(textOf(s.docs.get(home.id)), "");
  assert.equal(changed.conflicts, 1);

  const z = memorySink();
  const files = { [`Home ${hex(u(1))}.md`]: "# Home\n\nzip body\n" };
  await zipImport(z, files);
  const zhome = pageTitled(z.tree, "Home");
  clearBody(z.docs.get(zhome.id));
  await zipImport(z, files);
  assert.equal(textOf(z.docs.get(zhome.id)), "");
});

test("3: a body that goes A, empty, then A again in Notion comes back", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  await recordsImport(s, makeRecords({ homeContent: [u(60)] }));
  assert.equal(textOf(s.docs.get(home.id)), "");
  await recordsImport(s, makeRecords());
  assert.match(textOf(s.docs.get(home.id)), /hello from notion/);
});

const boldOrLiteral = (bold) => makeRecords({ homeContent: [u(5), u(60)], extraBlocks: [block(u(5), "text", { properties: { title: bold ? [["x", [["b"]]]] : [["<bold>x</bold>"]] } })] });

test("3: two Macs importing different first versions whose text looks alike converge to the same document", async () => {
  const a = memorySink();
  const b = memorySink();
  await recordsImport(a, boldOrLiteral(true));
  await recordsImport(b, boldOrLiteral(false));
  merge(a, b);
  const home = pageTitled(a.tree, "Home");
  const json = JSON.stringify(a.docs.get(home.id).getXmlFragment("blocks").toJSON());
  assert.equal(json, JSON.stringify(b.docs.get(home.id).getXmlFragment("blocks").toJSON()));
});

test("3: two Macs importing the same first version at once keep one copy, and a copy edited here is never dropped", async () => {
  const a = memorySink();
  const b = memorySink();
  await recordsImport(a, makeRecords());
  await recordsImport(b, makeRecords());
  const home = pageTitled(a.tree, "Home");
  addParagraph(b.docs.get(home.id), "edited before the merge");
  merge(a, b);
  const text = textOf(a.docs.get(home.id));
  assert.match(text, /edited before the merge/);
  assert.equal(text.match(/hello from notion/g)?.length, 2, "an edited copy isn't treated as a duplicate");

  const c = memorySink();
  const d = memorySink();
  await recordsImport(c, makeRecords());
  await recordsImport(d, makeRecords());
  merge(c, d);
  assert.equal(textOf(c.docs.get(pageTitled(c.tree, "Home").id)).match(/hello from notion/g)?.length, 1);
});

test("7: a page with no import base keeps local values that differ from Notion and counts a conflict, then records the base", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  const entry = s.tree.getMap("pages").get(home.id);
  s.tree.transact(() => {
    entry.delete("imported");
    entry.set("title", "Mine");
    entry.set("fullWidth", true);
    entry.set("locked", true);
  });
  const renamed = makeRecords();
  renamed.blocks[u(1)].value.value.properties.title = [["Home v2"]];
  const first = await recordsImport(s, renamed);
  const after = model.getPage(s.tree, home.id);
  assert.deepEqual([after.title, after.fullWidth, after.locked], ["Mine", true, true]);
  assert.ok(first.conflicts >= 1);
  const again = await recordsImport(s, renamed);
  assert.equal(model.getPage(s.tree, home.id).title, "Mine");
  assert.equal(again.conflicts, 0, "once the base is recorded an unchanged source is quiet");

  const z = memorySink();
  await zipImport(z, { [`Home ${hex(u(1))}.md`]: "# Home\n\nzip body\n" });
  const zipped = pageTitled(z.tree, "Home");
  const wide = makeRecords();
  wide.blocks[u(1)].value.value.format = { page_full_width: true };
  await recordsImport(z, wide);
  assert.equal(model.getPage(z.tree, zipped.id).fullWidth, false, "a setting the zip never recorded isn't reset by a records import");
});

test("2: a page whose blocks a partial crawl didn't read keeps its body and base", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  const partial = makeRecords();
  delete partial.blocks[u(2)];
  partial.incomplete = { collections: [], blocks: [u(2)] };
  await recordsImport(s, partial);
  assert.match(textOf(s.docs.get(home.id)), /hello from notion/, "the unread body isn't erased");
  await recordsImport(s, makeRecords({ body: "complete again" }));
  assert.match(textOf(s.docs.get(home.id)), /complete again/, "a later complete crawl still updates it, so the base was kept");
});
