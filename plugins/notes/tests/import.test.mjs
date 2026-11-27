import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { load, until } from "./support/build.mjs";

const M = await load();
const { Y, model, database: D, fflate } = M;

const FIX = fileURLToPath(new URL("./fixtures/import/", import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), "notes-import-"));
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

function walkDir(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkDir(full, base, out);
    else out[relative(base, full)] = new Uint8Array(readFileSync(full));
  }
  return out;
}

function zipOf(dir, prefix = "") {
  const files = {};
  for (const [path, data] of Object.entries(walkDir(dir))) files[prefix + path] = [data, { level: 6 }];
  return fflate.zipSync(files);
}

function sinkFor() {
  const tree = new Y.Doc();
  const docs = new Map();
  const stored = new Map();
  return {
    tree,
    docs,
    stored,
    sink: {
      tree,
      by: "tester",
      newDoc: (page) => {
        const doc = new Y.Doc();
        docs.set(page, doc);
        return doc;
      },
      putFile: async (bytes, ext) => {
        const sha = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
        stored.set(sha, { bytes, ext });
        return sha;
      },
      flush: async () => undefined,
      alive: () => true,
    },
  };
}

async function folderVfs(dir) {
  const files = M.nodeFiles({ data: scratch(), src: dir });
  cleanups.push(() => files.detach());
  const store = M.ardiaFileStore(files, "src");
  const base = await M.storeVfs(store);
  const spoolFiles = M.nodeFiles({ data: scratch() });
  cleanups.push(() => spoolFiles.detach());
  const spool = M.storeSpool(M.ardiaFileStore(spoolFiles, "data", "spool"), "t");
  return M.LayeredVfs.build(base, (path, size) => M.storeAccess(store, path, size), spool);
}

async function fileVfs(bytes, name) {
  const dir = scratch();
  writeFileSync(join(dir, name), bytes);
  return folderVfs(dir);
}

async function imported(source, vfs) {
  const plan = await M.planFor(source, vfs);
  const s = sinkFor();
  const result = await M.writePlan(plan, s.sink, { title: `${source} import`, icon: "📥" }, () => {}, () => false, Date.UTC(2026, 10, 24));
  const pages = model.allPages(s.tree);
  const byTitle = (title) => {
    const found = pages.filter((p) => p.title === title);
    assert.equal(found.length, 1, `one page titled ${title}: ${pages.map((p) => p.title).join(", ")}`);
    return found[0];
  };
  const blocks = (id) => readBlocks(s.docs.get(id));
  return { ...s, result, pages, byTitle, blocks, plan };
}

function inlineOf(el) {
  const out = [];
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) for (const d of child.toDelta()) out.push({ text: d.insert, ...(d.attributes && Object.keys(d.attributes).length ? { marks: d.attributes } : {}) });
    else out.push({ node: child.nodeName, attrs: child.getAttributes(), text: child.toArray().map((c) => (c instanceof Y.XmlText ? c.toString() : "")).join("") });
  }
  return out;
}

function readBlocks(doc) {
  if (!doc) return [];
  const frag = model.blocksOf(doc);
  const group = frag.toArray()[0];
  if (!group) return [];
  const walk = (g) =>
    g.toArray().map((box) => {
      const [content, children] = box.toArray();
      const inline = content.nodeName === "table" ? [] : inlineOf(content);
      return {
        type: content.nodeName,
        attrs: content.getAttributes(),
        text: inline.map((i) => (i.text ?? "")).join(""),
        inline,
        ...(content.nodeName === "table" ? { rows: content.toArray().map((tr) => tr.toArray().map((td) => td.toArray().map((p) => inlineOf(p).map((i) => i.text).join("")).join(""))) } : {}),
        children: children ? walk(children) : [],
      };
    });
  return walk(group);
}

const flat = (blocks) => blocks.flatMap((b) => [b, ...flat(b.children)]);
const mentions = (blocks) => flat(blocks).flatMap((b) => b.inline.filter((i) => i.node === "mention").map((i) => i.attrs.pageId));
const noScript = (s) => {
  for (const doc of s.docs.values()) {
    const json = JSON.stringify(model.blocksOf(doc).toJSON());
    assert.doesNotMatch(json, /javascript:|<script|alert\(1\)|onerror|iframe/i, json.slice(0, 400));
  }
};

test("Notion: a nested zip of Markdown & CSV becomes a page tree, a typed database with rows, links and an image", async () => {
  const inner = zipOf(join(FIX, "notion"));
  const outer = fflate.zipSync({ "Export-abc-Part-1.zip": [inner, { level: 0 }] });
  const vfs = await fileVfs(outer, "Export-abc.zip");
  const s = await imported("notion", vfs);
  const root = s.pages.find((p) => p.parent === "");
  assert.equal(root.title, "notion import");
  const ws = s.byTitle("Workspace");
  const projects = s.byTitle("Projects");
  const tasks = s.byTitle("Tasks");
  assert.equal(ws.parent, root.id);
  assert.equal(projects.parent, ws.id);
  assert.equal(tasks.parent, ws.id);
  assert.equal(tasks.kind, "database");
  const rows = s.pages.filter((p) => p.parent === tasks.id);
  assert.deepEqual(rows.map((r) => r.title).sort(), ["Celebrate", "Ship it", "Write spec"]);
  const schema = D.readSchema(s.docs.get(tasks.id));
  const prop = (name) => schema.find((p) => p.name === name);
  assert.equal(prop("Status").type, "select");
  assert.equal(prop("Tags").type, "multi_select");
  assert.equal(prop("Due").type, "date");
  assert.equal(prop("Done").type, "checkbox");
  assert.equal(prop("Points").type, "number");
  assert.equal(prop("Link").type, "url");
  assert.equal(prop("Assignee").type, "text");
  const spec = rows.find((r) => r.title === "Write spec");
  assert.equal(D.selectValue(spec, prop("Status")).name, "In progress");
  assert.deepEqual(D.multiValue(spec, prop("Tags")).map((o) => o.name), ["docs", "urgent"]);
  assert.deepEqual(D.dateValue(spec, prop("Due")), { start: "2026-11-24" });
  assert.equal(D.checkValue(spec, prop("Done")), true);
  assert.equal(spec.props[prop("Points").id], 3);
  assert.equal(spec.props[prop("Assignee").id], "Ada Lovelace");
  const specBlocks = s.blocks(spec.id);
  assert.deepEqual(specBlocks.map((b) => b.type), ["paragraph"], "the row page keeps its body, not the property lines or the title");
  assert.deepEqual(mentions(specBlocks), [ws.id]);
  const wsBlocks = flat(s.blocks(ws.id));
  const types = wsBlocks.map((b) => b.type);
  for (const t of ["paragraph", "callout", "checkListItem", "numberedListItem", "bulletListItem", "toggleListItem", "codeBlock", "equation", "quote", "divider", "table", "image"]) assert.ok(types.includes(t), `${t} in ${types.join(",")}`);
  assert.ok(!types.includes("heading"), "the title heading isn't repeated in the body");
  const intro = wsBlocks[0];
  assert.deepEqual(mentions([intro]), [projects.id]);
  assert.ok(intro.inline.some((i) => i.text === "bold" && i.marks?.bold));
  assert.ok(intro.inline.some((i) => i.text === "the web" && i.marks?.link?.href === "https://example.com"));
  assert.match(intro.text, /and bad\./, "a javascript: link keeps its words");
  assert.ok(intro.inline.every((i) => !i.marks?.link || /^https:/.test(i.marks.link.href)), "and loses its address");
  assert.equal(wsBlocks.find((b) => b.type === "callout").attrs.icon, "💡");
  assert.equal(wsBlocks.find((b) => b.type === "callout").text.trim(), "Remember the milk.");
  assert.deepEqual(wsBlocks.filter((b) => b.type === "checkListItem").map((b) => [b.text, b.attrs.checked]), [["Write the plan", false], ["Book the room", true]]);
  const toggle = wsBlocks.find((b) => b.type === "toggleListItem");
  assert.equal(toggle.text, "Open me");
  assert.match(toggle.children[0].text, /Hidden text inside/);
  assert.equal(wsBlocks.find((b) => b.type === "codeBlock").attrs.language, "python");
  assert.equal(wsBlocks.find((b) => b.type === "equation").text, "E = mc^2");
  assert.deepEqual(wsBlocks.find((b) => b.type === "table").rows, [["Name", "Count"], ["Apples", "3"]]);
  const image = wsBlocks.find((b) => b.type === "image");
  assert.match(image.attrs.url, /^file:[0-9a-f]{64}$/);
  assert.ok(s.stored.has(image.attrs.url.slice(5)));
  assert.equal(s.result.databases, 1);
  assert.equal(s.result.attachments, 1);
  assert.ok(mentions(s.blocks(ws.id)).includes(tasks.id), "the inline link to the CSV database points at the database page");
  noScript(s);
});

test("Notion as real exports name it: a rows folder without an id, duplicate and shortened row titles, CSV and PDF attachments, ? and # in titles", async () => {
  const id = (n) => String(n).repeat(32).slice(0, 32);
  const enc = new TextEncoder();
  const files = {
    [`People ${id(1)}.csv`]: enc.encode("Name,Role\nAda,Engineer\nAda,Designer\nA very long title that Notion cut short in the file name,Writer\nNobody,Ghost\n"),
    [`People ${id(1)}_all.csv`]: enc.encode("Name,Role\nAda,Engineer\nAda,Designer\nA very long title that Notion cut short in the file name,Writer\nNobody,Ghost\n"),
    [`People/Ada ${id(2)}.md`]: enc.encode("# Ada\n\nRole: Engineer\n\nFirst Ada's body."),
    [`People/Ada ${id(3)}.md`]: enc.encode("# Ada\n\nRole: Designer\n\nSecond Ada's body."),
    [`People/A very long title that Notion cut ${id(4)}.md`]: enc.encode("# A very long title that Notion cut short in the file name\n\nThe long one's body."),
    [`People/Stray ${id(9)}.md`]: enc.encode("# Stray\n\nA row the CSV doesn't list."),
    [`Home ${id(5)}.md`]: enc.encode(`# Home\n\n[data.csv](Home%20${id(5)}/data.csv)\n\n[report.pdf](Home%20${id(5)}/report.pdf)\n\nSee [the deck](Home%20${id(5)}/deck.pdf?v=2) inline.\n\nGo to [What? #1](What%3F%20%231%20${id(6)}.md#part) and [People](People%20${id(1)}.csv).`),
    [`Home ${id(5)}/data.csv`]: enc.encode("a,b\n1,2\n"),
    [`Home ${id(5)}/report.pdf`]: enc.encode("%PDF-1.4 report"),
    [`Home ${id(5)}/deck.pdf`]: enc.encode("%PDF-1.4 deck"),
    [`What? #1 ${id(6)}.md`]: enc.encode("# What? #1\n\nQuestions."),
  };
  const vfs = await fileVfs(fflate.zipSync(files), "real.zip");
  const s = await imported("notion", vfs);
  const root = s.pages.find((p) => p.parent === "");
  const people = s.byTitle("People");
  assert.equal(people.kind, "database");
  assert.equal(people.parent, root.id);
  const rows = s.pages.filter((p) => p.parent === people.id);
  assert.deepEqual(rows.map((r) => r.title).sort(), ["A very long title that Notion cut short in the file name", "Ada", "Ada", "Nobody", "Stray"]);
  const bodies = rows.map((r) => s.blocks(r.id).map((b) => b.text).join(" ")).sort();
  assert.deepEqual(bodies.filter(Boolean), ["A row the CSV doesn't list.", "First Ada's body.", "Second Ada's body.", "The long one's body."], "every row file lands on a row, in CSV order");
  assert.equal(s.pages.filter((p) => p.parent === root.id).map((p) => p.title).sort().join(","), "Home,People,What? #1", "no row file is a stray top-level page");
  assert.equal(s.result.databases, 1, "a CSV beside a page is an attachment, not a database");
  const home = flat(s.blocks(s.byTitle("Home").id));
  const fileBlocks = home.filter((b) => b.type === "file");
  assert.deepEqual(fileBlocks.map((b) => b.attrs.name).sort(), ["data.csv", "deck.pdf", "report.pdf"]);
  assert.ok(fileBlocks.every((b) => /^file:[0-9a-f]{64}$/.test(b.attrs.url)));
  assert.equal(fileBlocks.find((b) => b.attrs.name === "deck.pdf").attrs.caption, "the deck");
  assert.ok(home.some((b) => b.type === "paragraph" && /See the deck inline\./.test(b.text)), "a file linked mid-sentence keeps its words");
  assert.ok(!home.some((b) => b.type === "paragraph" && /^(data\.csv|report\.pdf)$/.test(b.text.trim())), "the file form leaves no empty link paragraph");
  assert.deepEqual(mentions(home).sort(), [s.byTitle("What? #1").id, people.id].sort(), "a title with ? and # still links, and the database link stays a link");
});

test("Markdown links: only the raw query or fragment is cut, and a local file link becomes a file block", () => {
  const blocks = M.parseMarkdown("[q](What%3F%20%231.md?x=1#top)\n\n[spec.pdf](spec.pdf)\n\n[note](note.md)");
  assert.equal(blocks[0].content[0].target, "path:What? #1.md");
  assert.deepEqual(blocks[1], { type: "file", src: "spec.pdf", props: {} });
  assert.equal(blocks[2].content[0].target, "path:note.md");
});

test("Notion HTML export: titles, icons, to-dos, callouts, equations, code and child pages, scripts dropped", async () => {
  const vfs = await fileVfs(zipOf(join(FIX, "notion-html")), "html.zip");
  const s = await imported("notion", vfs);
  const home = s.byTitle("Home");
  const child = s.byTitle("Child");
  assert.equal(home.icon, "🏠");
  assert.equal(child.parent, home.id);
  const blocks = flat(s.blocks(home.id));
  assert.deepEqual(mentions(blocks), [child.id]);
  assert.ok(blocks.some((b) => b.type === "checkListItem" && b.attrs.checked === true && b.text === "Done thing"));
  assert.ok(blocks.some((b) => b.type === "callout" && b.attrs.icon === "⚠️" && b.text === "Be careful"));
  assert.ok(blocks.some((b) => b.type === "equation" && b.text === "a^2+b^2"));
  assert.ok(blocks.some((b) => b.type === "image" && /^file:/.test(b.attrs.url)));
  const childBlocks = flat(s.blocks(child.id));
  assert.equal(childBlocks.find((b) => b.type === "codeBlock").attrs.language, "javascript");
  assert.ok(childBlocks.some((b) => b.type === "heading" && b.text === "Section"));
  noScript(s);
});

test("Obsidian: folders, wikilinks with aliases, embeds, frontmatter, callouts, highlights and attachments", async () => {
  const s = await imported("obsidian", await folderVfs(join(FIX, "obsidian")));
  const titles = s.pages.map((p) => p.title).sort();
  assert.deepEqual(titles, ["Alpha", "Beta", "Home", "Projects", "attachments", "obsidian import"].filter((t) => t !== "attachments").sort());
  const home = s.byTitle("Home");
  const alpha = s.byTitle("Alpha");
  const beta = s.byTitle("Beta");
  const projects = s.byTitle("Projects");
  assert.equal(alpha.parent, projects.id);
  const blocks = flat(s.blocks(home.id));
  const props = blocks.find((b) => b.type === "toggleListItem" && b.text === "Properties");
  assert.ok(props, "frontmatter becomes a Properties toggle");
  assert.deepEqual(props.children.map((c) => c.text), ["tags: inbox, personal", "rating: 5"]);
  assert.deepEqual(mentions(blocks), [alpha.id, beta.id]);
  assert.ok(!JSON.stringify(blocks).includes("private comment"), "%% comments %% are dropped");
  assert.ok(blocks.some((b) => b.inline.some((i) => i.node === "hardBreak")), "single newlines stay line breaks");
  assert.ok(blocks.some((b) => b.inline.some((i) => i.text === "highlight" && i.marks?.backgroundColor)));
  assert.ok(blocks.some((b) => b.type === "image" && /^file:/.test(b.attrs.url)), "![[pic.png]] finds the attachment anywhere in the vault");
  const callout = blocks.find((b) => b.type === "callout");
  assert.equal(callout.attrs.icon, "⚠️");
  assert.equal(callout.text, "Careful");
  assert.equal(callout.children[0].text, "Mind the gap.");
  assert.ok(!JSON.stringify(blocks).includes("^block-1"));
  const alphaBlocks = flat(s.blocks(alpha.id));
  assert.deepEqual(mentions(alphaBlocks), [home.id, home.id], "[[Start]] resolves through the alias");
  assert.ok(alphaBlocks.some((b) => b.type === "linkToPage" && b.attrs.pageId === beta.id), "![[Beta]] embeds the note as a link to it");
  assert.ok(alphaBlocks.some((b) => b.type === "file" && b.attrs.name === "report.pdf"));
});

test("Logseq: journals, namespaces, outline bullets, tasks, properties and links", async () => {
  const s = await imported("logseq", await folderVfs(join(FIX, "logseq")));
  const journals = s.byTitle("Journals");
  const day = s.byTitle("2026-11-24");
  assert.equal(day.parent, journals.id);
  const area = s.byTitle("Area");
  const health = s.byTitle("Health");
  assert.equal(health.parent, area.id);
  const px = s.byTitle("Project X");
  const blocks = s.blocks(day.id);
  assert.deepEqual(blocks.map((b) => [b.type, b.text]).slice(0, 2), [["checkListItem", "buy milk"], ["checkListItem", "write the report"]]);
  assert.equal(blocks[1].attrs.checked, true);
  assert.deepEqual(mentions(blocks), [px.id]);
  assert.ok(blocks[2].text.includes("big plans"));
  assert.equal(blocks[2].children[0].text, "nested detail");
  assert.ok(!JSON.stringify(blocks).includes("id::"), "block ids are dropped");
  const pxBlocks = s.blocks(px.id);
  assert.equal(pxBlocks[0].type, "toggleListItem");
  assert.deepEqual(pxBlocks[0].children.map((c) => c.text), ["type: project"]);
  assert.deepEqual(mentions(s.blocks(s.byTitle("Health").id)), []);
  assert.equal(pxBlocks[1].children[0].text, "A child bullet");
});

test("Bear: a textbundle keeps its title and image; plain Markdown sits beside it", async () => {
  const s = await imported("bear", await folderVfs(join(FIX, "bear")));
  const note = s.byTitle("Bear Note");
  s.byTitle("Plain");
  const blocks = flat(s.blocks(note.id));
  assert.ok(blocks.some((b) => b.inline.some((i) => i.text === "a highlight" && i.marks?.backgroundColor)));
  assert.ok(blocks.some((b) => b.type === "image" && /^file:/.test(b.attrs.url)));
  assert.ok(!blocks.some((b) => b.type === "heading"));
});

test("Evernote: an .enex keeps titles, dates, tags, to-dos, lists, images by hash and note links, and drops scripts", async () => {
  const s = await imported("evernote", await folderVfs(join(FIX, "evernote")));
  const trip = s.byTitle("Trip & plans");
  const second = s.byTitle("Second note");
  assert.equal(trip.createdAt, Date.UTC(2026, 10, 1, 9, 30));
  const blocks = flat(s.blocks(trip.id));
  assert.deepEqual(blocks[0].children.map((c) => c.text), ["Tags: travel, 2026", "Source: https://example.com/trip"]);
  assert.ok(blocks.some((b) => b.text === "Pack list" && b.inline[0].marks?.bold));
  assert.deepEqual(blocks.filter((b) => b.type === "checkListItem").map((b) => [b.text, b.attrs.checked]), [["Passport", true], ["Charger", false]]);
  assert.deepEqual(s.blocks(trip.id).filter((b) => b.type === "bulletListItem").map((b) => b.text), ["Socks", "Hat"]);
  const image = blocks.find((b) => b.type === "image");
  assert.equal(image.attrs.name, "map.png");
  assert.ok(s.stored.has(image.attrs.url.slice(5)));
  assert.deepEqual(mentions(blocks), [second.id]);
  const secondBlocks = flat(s.blocks(second.id));
  assert.ok(secondBlocks.some((b) => b.type === "heading" && b.text === "Heading"));
  assert.deepEqual(secondBlocks.find((b) => b.type === "table").rows, [["a", "b"]]);
  noScript(s);
});

test("Roam: pages, daily notes, TODO/DONE, headings, block refs, Roam italics and highlights, page links", async () => {
  const s = await imported("roam", await folderVfs(join(FIX, "roam")));
  const day = s.byTitle("November 24th, 2026");
  const ada = s.byTitle("Ada");
  const idea = s.byTitle("idea");
  const blocks = s.blocks(day.id);
  assert.equal(blocks[0].type, "checkListItem");
  assert.equal(blocks[0].attrs.checked, false);
  assert.deepEqual(mentions([blocks[0]]), [ada.id]);
  assert.ok(blocks[1].inline.some((i) => i.text === "italic" && i.marks?.italic));
  assert.ok(blocks[1].inline.some((i) => i.text === "bold" && i.marks?.bold));
  assert.ok(blocks[1].inline.some((i) => i.text === "mark" && i.marks?.backgroundColor));
  assert.deepEqual(mentions([{ ...blocks[1], children: [] }]), [idea.id]);
  assert.match(blocks[1].children[0].text, /call/, "a block ref shows the block's words");
  assert.equal(blocks[2].type, "heading");
  assert.equal(blocks[2].attrs.level, 2);
  assert.equal(s.blocks(ada.id)[0].attrs.checked, true);
});

test("Google Keep: lists, labels, archived notes, attachments by name, links; trashed notes skipped", async () => {
  const s = await imported("keep", await folderVfs(join(FIX, "keep")));
  const groceries = s.byTitle("Groceries");
  const idea = s.byTitle("First line");
  const archived = s.byTitle("Archived");
  assert.equal(idea.parent, archived.id);
  assert.ok(!s.pages.some((p) => p.title === "Trashed"));
  const g = s.blocks(groceries.id);
  assert.deepEqual(g[0].children.map((c) => c.text), ["Labels: Home", "Pinned: Yes"]);
  assert.deepEqual(g.filter((b) => b.type === "checkListItem").map((b) => [b.text, b.attrs.checked]), [["Eggs", true], ["Bread", false]]);
  const i = s.blocks(idea.id);
  assert.ok(i.some((b) => b.type === "image" && /^file:/.test(b.attrs.url)), "Idea.jpeg finds Idea.jpg");
  assert.ok(i.some((b) => b.type === "bookmark" && b.attrs.url === "https://example.com/read"));
  assert.ok(i.some((b) => b.inline.some((x) => x.marks?.link?.href === "https://example.com")));
});

function tarOf(dir) {
  const files = walkDir(dir);
  const parts = [];
  for (const [path, data] of Object.entries(files)) {
    const head = new Uint8Array(512);
    const enc = new TextEncoder();
    head.set(enc.encode(path.slice(0, 99)), 0);
    head.set(enc.encode("0000644\0"), 100);
    head.set(enc.encode("0000000\0"), 108);
    head.set(enc.encode("0000000\0"), 116);
    head.set(enc.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
    head.set(enc.encode("00000000000\0"), 136);
    head[156] = 48;
    head.set(enc.encode("ustar\0"), 257);
    head.set(enc.encode("00"), 263);
    head.fill(32, 148, 156);
    let sum = 0;
    for (const b of head) sum += b;
    head.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    parts.push(head, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return Buffer.concat(parts);
}

test("Joplin: a .jex keeps notebooks, notes, resources and note links", async () => {
  const s = await imported("joplin", await fileVfs(tarOf(join(FIX, "joplin", "items")), "all.jex"));
  const work = s.byTitle("Work");
  const meeting = s.byTitle("Meeting");
  const next = s.byTitle("Next steps");
  assert.equal(meeting.parent, work.id);
  assert.equal(next.parent, work.id);
  const blocks = flat(s.blocks(meeting.id));
  assert.deepEqual(mentions(blocks), [next.id]);
  assert.ok(blocks.some((b) => b.type === "image" && /^file:/.test(b.attrs.url)));
  assert.ok(blocks.some((b) => b.type === "checkListItem" && b.text === "follow up"));
});

test("Simplenote: notes.json in a zip, first line as title, tags, Markdown notes, trash skipped", async () => {
  const s = await imported("simplenote", await fileVfs(zipOf(join(FIX, "simplenote")), "notes.zip"));
  const shopping = s.byTitle("Shopping");
  const md = s.byTitle("Markdown note");
  assert.ok(!s.pages.some((p) => p.title === "gone"));
  assert.deepEqual(s.blocks(shopping.id)[0].children.map((c) => c.text), ["Tags: home"]);
  assert.ok(s.blocks(md.id).some((b) => b.inline.some((i) => i.text === "bold" && i.marks?.bold)));
});

test("Markdown, text and HTML in folders: folders become pages, relative links resolve, scripts and handlers go", async () => {
  const s = await imported("markdown", await folderVfs(join(FIX, "markdown")));
  const folder = s.byTitle("Folder");
  const a = s.byTitle("Note A");
  const b = s.byTitle("Note B");
  s.byTitle("Loose");
  const html = s.byTitle("Page");
  assert.equal(a.parent, folder.id);
  assert.deepEqual(mentions(s.blocks(a.id)), [b.id]);
  const loose = s.blocks(s.byTitle("Loose").id);
  assert.equal(loose.length, 2);
  assert.ok(loose[0].inline.some((i) => i.node === "hardBreak"));
  assert.ok(s.blocks(html.id).some((x) => x.inline.some((i) => i.text === "em" && i.marks?.italic)));
  noScript(s);
});

test("zip entries can't leave the export: .., absolute and drive paths are refused, names are cleaned", () => {
  assert.equal(M.cleanEntryName("../../etc/passwd"), null);
  assert.equal(M.cleanEntryName("a/../../b"), null);
  assert.equal(M.cleanEntryName("/abs/file.md"), null);
  assert.equal(M.cleanEntryName("C:\\Windows\\x.md"), null);
  assert.equal(M.cleanEntryName("a\u0000b"), null);
  assert.equal(M.cleanEntryName("a\\b\\c.md"), "a/b/c.md");
  assert.equal(M.cleanEntryName("./a//b.md"), "a/b.md");
});

test("hostile zips: a zip slip, a bomb, a huge entry and garbage import what's safe and nothing else", async () => {
  const slip = fflate.zipSync({ "../../evil.md": new TextEncoder().encode("# Evil"), "/abs.md": new TextEncoder().encode("# Abs"), "ok.md": new TextEncoder().encode("# Fine\n\nok") });
  const s = await imported("markdown", await fileVfs(slip, "slip.zip"));
  assert.deepEqual(s.pages.map((p) => p.title).sort(), ["markdown import", "ok"]);
  const bomb = fflate.zipSync({ "bomb.md": [new Uint8Array(64 * 1024 * 1024), { level: 9 }], "fine.md": new TextEncoder().encode("ok") });
  const reader = await M.ZipReader.open({ size: bomb.length, read: async (o, l) => bomb.subarray(o, o + l) });
  assert.deepEqual(reader.entries.map((e) => e.name), ["fine.md"], "a 64 MB file of zeros packed 1000× is refused");
  assert.equal(reader.refused, 1);
  const lying = new Uint8Array(fflate.zipSync({ "liar.md": [new TextEncoder().encode("x".repeat(5000)), { level: 9 }] }));
  const view = new DataView(lying.buffer);
  for (let i = lying.length - 22; i >= 0; i--)
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, 10, true);
      break;
    }
  const liar = await M.ZipReader.open({ size: lying.length, read: async (o, l) => lying.subarray(o, o + l) });
  await assert.rejects(liar.read(liar.entries[0], 1 << 20), /size the zip says|damaged|unpacked/, "an entry that inflates past its declared size fails");
  const big = await M.ZipReader.open({ size: slip.length, read: async (o, l) => slip.subarray(o, o + l) });
  await assert.rejects(big.read(big.entries[0], 2), /too big/);
  await assert.rejects(M.ZipReader.open({ size: 100, read: async () => new Uint8Array(100) }), /isn't a zip/);
  const many = {};
  for (let i = 0; i < 20; i++) many[`f${i}.md`] = new TextEncoder().encode(`# N${i}`);
  const nested = fflate.zipSync({ "a.zip": fflate.zipSync({ "b.zip": fflate.zipSync(many) }) });
  const deep = await imported("markdown", await fileVfs(nested, "nested.zip"));
  assert.equal(deep.pages.length, 21, "nested zips unpack through the spool");
});

test("hostile text: malformed .enex and JSON, deep nesting and scripts never throw past the importer or reach a page", async () => {
  const enex = await imported("evernote", await fileVfs(readFileSync(join(FIX, "hostile", "malformed.enex")), "bad.enex"));
  assert.deepEqual(enex.pages.map((p) => p.title).sort(), ["Nothing to import", "evernote import"]);
  await assert.rejects(M.planFor("roam", await fileVfs(readFileSync(join(FIX, "hostile", "malformed.json")), "bad.json")), /isn't valid JSON/);
  const deep = await imported("markdown", await fileVfs(readFileSync(join(FIX, "hostile", "deep.md")), "deep.md"));
  assert.equal(deep.pages.length, 2);
  const html = M.parseHtml(`<div>${"<div>".repeat(5000)}x${"</div>".repeat(5000)}</div><script>alert(1)</script><a href="javascript:alert(1)">j</a><a href=" JaVaScRiPt:alert(1)">k</a><img src="data:text/html,x" onerror="alert(1)">`);
  const json = JSON.stringify(html);
  assert.doesNotMatch(json, /javascript|alert|onerror/i);
  for (const url of ["javascript:alert(1)", " javascript:x", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "ardia://settings"]) assert.equal(M.safeUrl(url), null, url);
  assert.equal(M.safeUrl("https://example.com/a"), "https://example.com/a");
  const yaml = M.splitFrontmatter("---\n__proto__: x\nconstructor: y\nok: 1\n---\nbody");
  assert.equal({}.x, undefined);
  assert.deepEqual(Object.keys(yaml.data), ["ok"]);
});

test("md5 matches Evernote's resource hashes", () => {
  assert.equal(M.md5Hex(new TextEncoder().encode("")), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(M.md5Hex(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")), "9e107d9d372bb6826bd81d3542a419d6");
  assert.equal(M.md5Hex(new Uint8Array(1000).fill(97)), "cabe45dcc9ae5b66ba86600cca6b8ba8");
});

function device(extra = {}) {
  const dir = scratch();
  mkdirSync(join(dir, "data"), { recursive: true });
  const files = M.nodeFiles({ data: join(dir, "data") });
  const folders = M.fakeFolders(files, join(dir, "shared"), []);
  const storage = new Map();
  const hub = M.pageHub();
  const picks = [];
  const host = {
    files,
    folders,
    storage: { get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined), set: async (k, v) => void storage.set(k, structuredClone(v)) },
    setting: () => "",
    post: hub.post,
    openPage: async () => {},
    openUrl: async () => {},
    store: { debounceMs: 5, rescanMs: 200 },
    pickFiles: async () => picks.splice(0),
    ...extra,
  };
  const notes = new M.Notes(host);
  hub.attach(notes);
  cleanups.push(async () => {
    await notes.stop();
    files.detach();
  });
  return { dir, files, folders, notes, storage, picks, host };
}

test("end to end through Notes: pick a Notion zip, watch its progress, land on its root page, spool cleaned", async () => {
  const d = device();
  await d.notes.start();
  const [ws] = d.notes.workspaces();
  const zipDir = scratch();
  const zip = fflate.zipSync({ "Part-1.zip": zipOf(join(FIX, "notion")) });
  writeFileSync(join(zipDir, "Export.zip"), zip);
  d.files.roots.set("pfeedfacecafe", zipDir);
  d.picks.push({ id: "pfeedfacecafe", name: "Export.zip", size: zip.length });
  const started = await d.notes.call("importStart", { workspace: ws.id, source: "notion", pick: "file" });
  assert.match(started.job, /^[0-9a-f]{12}$/);
  const job = await until(async () => {
    const j = await d.notes.call("importStatus", { job: started.job });
    return j.state === "done" || j.state === "failed" ? j : null;
  }, 10_000, "import done");
  assert.equal(job.state, "done", job.error);
  assert.ok(job.pages >= 5 && job.databases === 1 && job.attachments === 1, JSON.stringify(job));
  const tree = d.notes.treeOf(ws.id);
  const root = model.getPage(tree, job.root);
  assert.equal(root.title, "Notion import");
  assert.equal(root.parent, "");
  assert.equal(root.icon, "📥");
  assert.deepEqual(await d.notes.call("importStatus", {}), job, "the latest job answers without an id");
  assert.equal(existsSync(join(d.dir, "data", "import-spool")) ? readdirSync(join(d.dir, "data", "import-spool")).length : 0, 0, "the spool is emptied");
  assert.equal(d.storage.get("importStats")["notion.done"], 1);
  assert.equal(await d.notes.call("importStart", { workspace: ws.id, source: "notion", pick: "file" }), null, "a cancelled panel starts nothing");
  const again = await until(() => d.notes.call("importStatus", {}), 1000);
  assert.equal(again.id, job.id);
});

test("end to end: an Obsidian vault picked as a folder, then the grant is forgotten; cancel archives a partial import", async () => {
  const d = device();
  await d.notes.start();
  const [ws] = d.notes.workspaces();
  d.folders.pickQueue.push(M.grantFor(d.files, "fvault", join(FIX, "obsidian", "Vault"), "Vault"));
  const { job } = await d.notes.call("importStart", { workspace: ws.id, source: "obsidian", pick: "folder" });
  const done = await until(async () => {
    const j = await d.notes.call("importStatus", { job });
    return j.state === "done" || j.state === "failed" ? j : null;
  }, 10_000, "vault import");
  assert.equal(done.state, "done", done.error);
  assert.equal((await d.folders.list()).length, 0, "the vault's grant is forgotten after the import");
  const tree = d.notes.treeOf(ws.id);
  const kids = model.childrenOf(tree, done.root).map((p) => p.title).sort();
  assert.deepEqual(kids, ["Home", "Projects"]);
  const many = scratch();
  for (let i = 0; i < 400; i++) writeFileSync(join(many, `n${i}.md`), `# N${i}\n\n${"text ".repeat(200)}`);
  d.folders.pickQueue.push(M.grantFor(d.files, "fmany", many, "Many"));
  const second = await d.notes.call("importStart", { workspace: ws.id, source: "markdown", pick: "folder" });
  await until(async () => (await d.notes.call("importStatus", { job: second.job })).state === "writing", 10_000, "writing");
  await assert.rejects(d.notes.call("importStart", { workspace: ws.id, source: "markdown", pick: "folder" }), /already running/);
  await d.notes.call("importCancel", { job: second.job });
  const cancelled = await until(async () => {
    const j = await d.notes.call("importStatus", { job: second.job });
    return j.state === "cancelled" || j.state === "done" ? j : null;
  }, 10_000, "cancelled");
  assert.equal(cancelled.state, "cancelled");
  const roots = model.childrenOf(tree, "", { archived: true }).filter((p) => p.title === "Markdown & text import");
  assert.equal(roots.length, 1);
  assert.ok(roots[0].archivedAt > 0, "a cancelled import goes to the trash, where it can be restored");
});

test("an import the helper died in the middle of goes to the trash at the next start and reads failed", async () => {
  const d = device();
  await d.notes.start();
  const [ws] = d.notes.workspaces();
  const tree = d.notes.treeOf(ws.id);
  const root = model.createPage(tree, { parent: "", kind: "page", title: "Notion import", icon: "📥", by: "x" });
  model.createPage(tree, { parent: root, kind: "page", title: "Half a page", by: "x" });
  const kept = model.createPage(tree, { parent: "", kind: "page", title: "Notion import", by: "x", now: 1 });
  d.storage.set("importRunning", { id: "abcdef012345", source: "notion", workspace: ws.id, root, title: "Notion import", startedAt: Date.now() - 1000 });
  await d.notes.stop();
  const again = new M.Notes(d.host);
  cleanups.push(() => again.stop());
  await again.start();
  const job = await until(async () => {
    const j = await again.call("importStatus", {});
    return j && j.state === "failed" ? j : null;
  }, 5000, "the interrupted job");
  assert.equal(job.id, "abcdef012345");
  assert.match(job.error, /stopped when Notes did/);
  assert.equal(job.root, root);
  const after = again.treeOf(ws.id);
  await until(() => model.getPage(after, root)?.archivedAt > 0, 5000, "the partial tree archived");
  assert.equal(model.getPage(after, kept).archivedAt, 0, "an older page with the same title is left alone");
  await until(() => d.storage.get("importRunning") === null, 5000, "the record cleared");
  assert.equal(d.storage.get("importStats")["notion.failed"], 1);
  const third = new M.Notes(d.host);
  cleanups.push(() => third.stop());
  await third.start();
  assert.equal(await third.call("importStatus", {}), null, "it is cleaned up once");
});

test("a running import keeps a record of its root until it ends, and the record is cleared after", async () => {
  const d = device();
  await d.notes.start();
  const [ws] = d.notes.workspaces();
  const zipDir = scratch();
  const zip = fflate.zipSync({ "Part-1.zip": zipOf(join(FIX, "notion")) });
  writeFileSync(join(zipDir, "Export.zip"), zip);
  d.files.roots.set("pfeedfacecafe", zipDir);
  d.picks.push({ id: "pfeedfacecafe", name: "Export.zip", size: zip.length });
  const seen = [];
  const set = d.host.storage.set;
  d.host.storage.set = async (k, v) => {
    if (k === "importRunning") seen.push(v);
    return set(k, v);
  };
  const { job } = await d.notes.call("importStart", { workspace: ws.id, source: "notion", pick: "file" });
  const done = await until(async () => {
    const j = await d.notes.call("importStatus", { job });
    return j.state === "done" || j.state === "failed" ? j : null;
  }, 10_000, "import done");
  assert.equal(done.state, "done", done.error);
  await until(() => d.storage.get("importRunning") === null, 5000, "cleared");
  assert.equal(seen[0].id, job);
  assert.equal(seen[0].root, null);
  assert.ok(seen.some((r) => r && r.root === done.root), "the root is written down once it exists");
  assert.equal(seen.at(-1), null);
});

test("an export handed over in base64 parts (the CLI's way) imports exactly as a pick, then its staging is removed", async () => {
  const d = device();
  await d.notes.start();
  const [ws] = d.notes.workspaces();
  const zip = Buffer.from(fflate.zipSync({ "Part-1.zip": zipOf(join(FIX, "notion")) }));
  const b64 = zip.toString("base64");
  const step = 600;
  const parts = [];
  for (let at = 0; at < b64.length; at += step) parts.push(b64.slice(at, at + step));
  assert.ok(parts.length > 2);
  await assert.rejects(d.notes.call("importUpload", { uploadId: "cli-upload-1", i: 1, name: "x.zip", data: parts[1] }), /part 0/);
  for (const [i, data] of parts.entries()) await d.notes.call("importUpload", { uploadId: "cli-upload-1", i, name: "../../Notion export", data });
  const again = await d.notes.call("importUpload", { uploadId: "cli-upload-1", i: 0, name: "x", data: parts[0] });
  assert.equal(again.parts, parts.length, "a resent part is taken once");
  assert.equal(again.size, zip.length);
  await assert.rejects(d.notes.call("importUpload", { uploadId: "cli-upload-1", i: parts.length + 1, name: "x", data: "AAAA" }), /is next/);
  const staged = join(d.dir, "data", "import-uploads", "cli-upload-1");
  assert.deepEqual(readdirSync(staged), ["-..-Notion export.zip"], "the name is one plain file name, and a zip gets its extension");
  const { job } = await d.notes.call("importStart", { workspace: ws.id, source: "notion", uploadId: "cli-upload-1" });
  const done = await until(async () => {
    const j = await d.notes.call("importStatus", { job });
    return j.state === "done" || j.state === "failed" ? j : null;
  }, 10_000, "uploaded import");
  assert.equal(done.state, "done", done.error);
  assert.equal(done.databases, 1);
  assert.equal(done.attachments, 1);
  const tree = d.notes.treeOf(ws.id);
  assert.ok(model.allPages(tree).some((p) => p.title === "Workspace" && p.parent === done.root));
  assert.ok(!existsSync(staged) || readdirSync(staged).length === 0, "the staged export is removed");
  await assert.rejects(d.notes.call("importStart", { workspace: ws.id, source: "notion", uploadId: "cli-upload-1" }), /isn't here/);
  await assert.rejects(d.notes.call("importUpload", { uploadId: "bad id!", i: 0, name: "x", data: "AAAA" }), /upload id/);
  await assert.rejects(d.notes.call("importUpload", { uploadId: "cli-upload-2", i: 0, name: "x", data: "not base64!" }), /base64/);
});

test("Apple Notes straight from the app: consent first, folders nest, notes page in windows, locked notes stay locked, pictures come along", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const work = Array.from({ length: 63 }, (_, i) => ({ id: `w${i}`, name: `Work ${i}`, created: Date.UTC(2026, 0, 1 + (i % 28)), modified: 0, locked: false, body: `<div><h1>Work ${i}</h1></div><div>Body <b>${i}</b></div>` }));
  work[0] = { ...work[0], body: `<div><h1>Work 0</h1></div><div>See the map</div><div><img src="data:image/png;base64,${png.toString("base64")}"></div><ul><li>one</li><li>two</li></ul><script>alert(1)</script>` };
  work[1] = { ...work[1], locked: true, body: "" };
  const folders = [
    { id: "F-work", name: "Work", account: "iCloud", parent: "", count: work.length },
    { id: "F-ideas", name: "Ideas", account: "iCloud", parent: "F-work", count: 1 },
    { id: "F-trash", name: "Recently Deleted", account: "iCloud", parent: "", count: 1 },
  ];
  const byFolder = { "F-work": work, "F-ideas": [{ id: "i0", name: "Idea", created: 0, modified: 0, locked: false, body: "<div>Idea</div><div>Grow</div>" }], "F-trash": [{ id: "t0", name: "Gone", created: 0, modified: 0, locked: false, body: "x" }] };
  const calls = [];
  let allow = false;
  const appleNotes = {
    request: async () => (calls.push("request"), allow),
    folders: async () => (calls.push("folders"), folders),
    notes: async (folder, { offset, limit }) => {
      calls.push(`notes ${folder} ${offset} ${limit}`);
      assert.ok(limit <= 200);
      const all = byFolder[folder] ?? [];
      return { total: all.length, notes: all.slice(offset, offset + limit) };
    },
  };
  const d = device({ appleNotes });
  await d.notes.start();
  const [ws] = d.notes.workspaces();
  assert.equal(await d.notes.call("importStart", { workspace: ws.id, source: "apple-notes", pick: "app" }), null, "declining Ardia's sheet starts nothing");
  assert.deepEqual(calls, ["request"], "nothing is read before consent");
  allow = true;
  const { job } = await d.notes.call("importStart", { workspace: ws.id, source: "apple-notes", pick: "app" });
  const done = await until(async () => {
    const j = await d.notes.call("importStatus", { job });
    return j.state === "done" || j.state === "failed" ? j : null;
  }, 10_000, "apple notes import");
  assert.equal(done.state, "done", done.error);
  assert.equal(done.attachments, 1);
  assert.ok(!calls.some((c) => c.includes("F-trash") && c.startsWith("notes")), "Recently Deleted isn't read");
  assert.ok(calls.filter((c) => c.startsWith("notes F-work")).length <= 4, `notes are read in windows: ${calls.join(", ")}`);
  const tree = d.notes.treeOf(ws.id);
  const root = model.getPage(tree, done.root);
  assert.equal(root.title, "Apple Notes import");
  const workPage = model.childrenOf(tree, done.root).find((p) => p.title === "Work");
  const kids = model.childrenOf(tree, workPage.id);
  assert.equal(kids.length, 64);
  assert.ok(kids.some((p) => p.title === "Ideas"), "a nested folder sits in its parent");
  assert.ok(kids.some((p) => p.title === "Work 62"), "notes past the first window keep their titles");
  const store = d.notes.spaceStore(ws.id);
  const docOf = async (id) => {
    const doc = await store.get(`p-${id}`);
    return model.blocksOf(doc).toString();
  };
  const first = await docOf(kids.find((p) => p.title === "Work 0").id);
  assert.match(first, /See the map/);
  assert.match(first, /<image[^>]*url="file:[0-9a-f]{64}"/);
  assert.match(first, /bulletlistitem/i);
  assert.doesNotMatch(first, /Work 0<\/heading>|alert|script/, "the repeated title and scripts are gone");
  assert.match(await docOf(kids.find((p) => p.title === "Work 1").id), /locked in Apple Notes/);
  const late = model.getPage(tree, kids.find((p) => p.title === "Work 27").id);
  assert.equal(late.createdAt, Date.UTC(2026, 0, 28));
});

test("every source in the catalog has an importer and a hint", async () => {
  for (const source of M.IMPORT_SOURCES) {
    assert.ok(source.hint.length > 20 && source.hint.length < 200, source.id);
    const plan = await M.planFor(source.id, { files: [], read: async () => new Uint8Array(0) });
    assert.equal(plan.nodes[0].title, "Nothing to import", source.id);
  }
});
