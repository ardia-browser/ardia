import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./support/build.mjs";
import { WS, u, hex, wrap, SPACE, PNG, enc, block, makeRecords, memorySink, recordsReader, recordsImport, memoryVfs, zipImport, livePages, pageTitled, textOf, addParagraph, merge } from "./support/importWorld.mjs";

const M = await load();
const { Y, model } = M;

const HOME = `Home ${hex(u(1))}.md`;

test("1: re-importing unchanged Notion records keeps a local edit to the page body", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  addParagraph(s.docs.get(home.id), "my local note");
  const again = await recordsImport(s, makeRecords());
  assert.match(textOf(s.docs.get(home.id)), /my local note/, "the local edit survives an unchanged source");
  assert.equal(again.conflicts ?? 0, 0);
});

test("1: a Notion change to a page edited here keeps the local edit and counts a conflict, and an untouched page takes the change", async () => {
  const s = memorySink();
  await recordsImport(s, makeRecords());
  const home = pageTitled(s.tree, "Home");
  addParagraph(s.docs.get(home.id), "my local note");
  const changed = await recordsImport(s, makeRecords({ body: "rewritten in notion" }));
  const text = textOf(s.docs.get(home.id));
  assert.match(text, /my local note/);
  assert.equal(changed.conflicts, 1, "the clash is counted");

  const t = memorySink();
  await recordsImport(t, makeRecords());
  await recordsImport(t, makeRecords({ body: "rewritten in notion" }));
  const fresh = textOf(t.docs.get(pageTitled(t.tree, "Home").id));
  assert.match(fresh, /rewritten in notion/);
  assert.doesNotMatch(fresh, /hello from notion/);
});

test("1: re-importing an unchanged Notion zip keeps a local edit, and a page that fails to read keeps its body", async () => {
  const files = { [HOME]: "# Home\n\nhello from the zip\n" };
  const s = memorySink();
  await zipImport(s, files);
  const home = pageTitled(s.tree, "Home");
  addParagraph(s.docs.get(home.id), "zip local note");
  await zipImport(s, files);
  assert.match(textOf(s.docs.get(home.id)), /zip local note/);

  const t = memorySink();
  await zipImport(t, files);
  const id = pageTitled(t.tree, "Home").id;
  const result = await zipImport(t, files, { fail: (path) => path === HOME });
  assert.match(textOf(t.docs.get(id)), /hello from the zip/, "a failed read never writes an empty body");
  assert.ok(result.skipped >= 1);
});

test("5: a partial Notion crawl doesn't trash rows or pages it didn't read", async () => {
  const s = memorySink();
  const child = block(u(36), "page", { parent_table: "block", parent_id: u(1), properties: { title: [["Child"]] } });
  await recordsImport(s, makeRecords({ rows: [u(301), u(302), u(303)], homeContent: [u(2), u(60), u(36)], extraBlocks: [child] }));
  const row = pageTitled(s.tree, "Row 302");
  const kid = pageTitled(s.tree, "Child");
  const partial = makeRecords({ rows: [u(301), u(303)], homeContent: [u(2), u(60), u(36)] });
  partial.incomplete = { collections: [u(100)], blocks: [u(36)] };
  await recordsImport(s, partial);
  assert.equal(model.getPage(s.tree, row.id).archivedAt, 0, "a row past the crawl's limit stays");
  assert.equal(model.getPage(s.tree, kid.id).archivedAt, 0, "a page whose record wasn't read stays");

  const complete = makeRecords({ rows: [u(301), u(303)], homeContent: [u(2), u(60)] });
  await recordsImport(s, complete);
  assert.ok(model.getPage(s.tree, row.id).archivedAt > 0, "a complete crawl still trashes what's gone");
});

test("6: the same Notion page imported from a zip and from records is one page", async () => {
  const s = memorySink();
  await zipImport(s, { [HOME]: "# Home\n\nfrom the zip\n" });
  const fromZip = pageTitled(s.tree, "Home");
  await recordsImport(s, makeRecords());
  const both = pageTitled(s.tree, "Home");
  assert.equal(both.id, fromZip.id);

  const r = memorySink();
  await recordsImport(r, makeRecords());
  const fromRecords = pageTitled(r.tree, "Home");
  await zipImport(r, { [HOME]: "# Home\n\nfrom the zip\n" });
  assert.equal(pageTitled(r.tree, "Home").id, fromRecords.id, "an older records import is recognised by a later zip");
});


test("6: two Macs importing the same zip for the first time at once end with one root and one copy of each body", async () => {
  const files = { [HOME]: "# Home\n\nonly once\n" };
  const a = memorySink();
  const b = memorySink();
  await zipImport(a, files);
  await zipImport(b, files);
  merge(a, b);
  assert.equal(livePages(a.tree).filter((p) => p.title === "Notion import").length, 1, "one root");
  const home = pageTitled(a.tree, "Home");
  assert.equal(textOf(a.docs.get(home.id)).match(/only once/g)?.length, 1, "the body isn't doubled");

  const c = memorySink();
  const d = memorySink();
  await recordsImport(c, makeRecords());
  await recordsImport(d, makeRecords());
  merge(c, d);
  assert.equal(textOf(c.docs.get(pageTitled(c.tree, "Home").id)).match(/hello from notion/g)?.length, 1);
});

test("7: relative attachments with the same name in different folders keep their own bytes", async () => {
  const s = memorySink();
  const one = new Uint8Array([...PNG, 1]);
  const two = new Uint8Array([...PNG, 2]);
  await zipImport(s, { "A/note.md": "# A\n\n![](photo.png)\n", "A/photo.png": one, "B/note.md": "# B\n\n![](photo.png)\n", "B/photo.png": two }, { source: "markdown" });
  const urls = livePages(s.tree)
    .filter((p) => p.title === "note")
    .map((p) => JSON.stringify(model.blocksOf(s.docs.get(p.id)).toJSON()).match(/file:([0-9a-f]{64})/)?.[1]);
  assert.equal(urls.length, 2);
  assert.notEqual(urls[0], urls[1], "each page points at its own photo");
});

test("7: a records attachment replaced with different bytes of the same size is read again", async () => {
  const key = "attachment:aaaaaaaa-0000-4000-8000-000000000001:pic.png";
  const image = block(u(3), "image", { properties: { source: [[key]] } });
  const recs = () => {
    const r = makeRecords({ homeContent: [u(2), u(3), u(60)], extraBlocks: [image] });
    r.files[key] = { path: "files/pic.png", name: "pic.png", size: PNG.length + 1 };
    return r;
  };
  const s = memorySink();
  await recordsImport(s, recs(), recordsReader(new Map([["files/pic.png", new Uint8Array([...PNG, 1])]])));
  await recordsImport(s, recs(), recordsReader(new Map([["files/pic.png", new Uint8Array([...PNG, 2])]])));
  const want = Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array([...PNG, 2]))).toString("hex");
  const home = pageTitled(s.tree, "Home");
  assert.match(JSON.stringify(model.blocksOf(s.docs.get(home.id)).toJSON()), new RegExp(`file:${want}`), "the new bytes are used");
});
