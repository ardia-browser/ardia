import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, until } from "./support/build.mjs";

const M = await load();
const { Y, model, database: D } = M;
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const wrap = (value) => ({ value: { value, role: "editor" } });
const SPACE = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

function block(id, type, extra = {}) {
  return { id, type, alive: true, space_id: SPACE, created_time: 1700000000000, last_edited_time: 1700000500000, created_by_id: ME, last_edited_by_id: ME, ...extra };
}

function makeRecords() {
  const blocks = {};
  const add = (b) => (blocks[b.id] = wrap(b));
  const T = (...segs) => ({ title: segs });
  add(block(u(1), "page", { parent_table: "space", parent_id: SPACE, properties: T(["Home"]), format: { page_icon: "🏠", page_full_width: true, page_cover: "/images/page-cover/solid_blue.png", page_cover_position: 0.25 }, content: [u(2), u(3), u(4), u(5), u(6), u(7), u(8), u(9), u(10), u(11), u(12), u(13), u(14), u(15), u(16), u(17), u(18), u(19), u(20), u(21), u(22), u(23), u(24), u(25), u(26), u(27), u(28), u(29), u(30), u(31), u(32), u(33), u(34), u(35), u(36), u(40), u(60), u(80)] }));
  add(block(u(2), "header", { properties: T(["Big"]), format: { block_color: "blue" } }));
  add(block(u(3), "sub_header", { properties: T(["Fold"]), format: { toggleable: true }, content: [u(37)] }));
  add(block(u(37), "text", { properties: T(["inside"]) }));
  add(block(u(4), "sub_sub_header", { properties: T(["Three"]) }));
  add(block(u(5), "header_4", { properties: T(["Four"]) }));
  add(block(u(6), "text", { properties: T(["b", [["b"]]], ["i", [["i"]]], ["s", [["s"]]], ["c", [["c"]]], ["u", [["_"]]], ["link", [["a", "https://example.com"]]], ["red", [["h", "red"]]], ["hl", [["h", "yellow_background"]]]), format: { block_color: "gray_background" } }));
  add(block(u(7), "text", { properties: T(["‣", [["p", u(40)]]], [" "], ["‣", [["u", ME]]], [" "], ["‣", [["d", { type: "date", start_date: "2026-01-02" }]]], ["⁍", [["e", "x^2"]]], ["‣", [["lm", { href: "https://docs.example.com/a", title: "Docs page" }]]], ["‣", [["eoi", u(38)]]], ["inner", [["a", `/${u(40).replace(/-/g, "")}`]]]) }));
  add(block(u(38), "external_object_instance", { format: { original_url: "https://github.com/acme/repo/pull/7", domain: "github.com" } }));
  add(block(u(8), "bulleted_list", { properties: T(["bullet"]), content: [u(39)] }));
  add(block(u(39), "bulleted_list", { properties: T(["nested"]) }));
  add(block(u(9), "numbered_list", { properties: T(["first"]), format: { list_start_index: 3 } }));
  add(block(u(10), "to_do", { properties: { title: [["done"]], checked: [["Yes"]] } }));
  add(block(u(11), "toggle", { properties: T(["tog"]), content: [u(41)] }));
  add(block(u(41), "text", { properties: T(["hidden"]) }));
  add(block(u(12), "quote", { properties: T(["quoted"]) }));
  add(block(u(13), "callout", { properties: T(["note"]), format: { page_icon: "/icons/gem_gray.svg", block_color: "gray_background" } }));
  add(block(u(14), "code", { properties: { title: [["const a = 1"]], language: [["TypeScript"]] }, format: { code_wrap: true } }));
  add(block(u(15), "divider"));
  add(block(u(16), "image", { properties: { source: [["attachment:aaaaaaaa-0000-4000-8000-000000000001:pic.png"]], title: [["pic.png"]], caption: [["A caption"]] }, format: { block_width: 320, block_full_width: false, block_page_width: false } }));
  add(block(u(17), "video", { properties: { source: [["https://cdn.example.com/v.mp4"]] } }));
  add(block(u(18), "audio", { properties: { source: [["attachment:aaaaaaaa-0000-4000-8000-000000000002:a.m4a"]], title: [["a.m4a"]] } }));
  add(block(u(19), "pdf", { properties: { source: [["attachment:aaaaaaaa-0000-4000-8000-000000000003:doc.pdf"]], title: [["doc.pdf"]] } }));
  add(block(u(20), "file", { properties: { source: [["https://prod-files-secure.s3.us-west-2.amazonaws.com/x/y/report.csv?X-Amz=1"]], title: [["report.csv"]] } }));
  add(block(u(21), "embed", { properties: { source: [["https://maps.example.com/embed"]] }, format: { block_width: 600 } }));
  add(block(u(22), "figma"));
  add(block(u(23), "drive"));
  add(block(u(24), "table", { content: [u(42), u(43)], format: { table_block_column_order: ["a", "b"], table_block_column_header: true, table_block_column_format: { a: { width: 180, color: "blue_background" } } } }));
  add(block(u(42), "table_row", { properties: { a: [["H1"]], b: [["H2", [["b"]]]] } }));
  add(block(u(43), "table_row", { properties: { a: [["c1"]], b: [["c2"]] }, format: { block_color: "red" } }));
  add(block(u(25), "column_list", { content: [u(44), u(45)] }));
  add(block(u(44), "column", { format: { column_ratio: 0.25 }, content: [u(46)] }));
  add(block(u(45), "column", { format: { column_ratio: 0.75 }, content: [u(47)] }));
  add(block(u(46), "text", { properties: T(["left"]) }));
  add(block(u(47), "callout", { properties: T(["right callout"]), format: { page_icon: "👋" } }));
  add(block(u(26), "ai_block", { format: { ai_prompt_key: "summarize" }, content: [u(48)] }));
  add(block(u(48), "text", { properties: T(["summary text"]) }));
  add(block(u(27), "external_object_instance", { format: { original_url: "https://github.com/acme/repo", domain: "github.com" } }));
  add(block(u(28), "equation", { properties: T(["E=mc^2"]) }));
  add(block(u(29), "bookmark", { properties: { link: [["https://example.org"]] } }));
  add(block(u(30), "mystery_block", { properties: T(["odd"]) }));
  add(block(u(31), "alias", { format: { alias_pointer: { id: u(40) } } }));
  add(block(u(32), "table_of_contents"));
  add(block(u(33), "image", { properties: { source: [[`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`]] } }));
  add(block(u(34), "text", { properties: T([""]) }));
  add(block(u(35), "transclusion_container", { content: [u(49)] }));
  add(block(u(49), "text", { properties: T(["synced"]) }));
  add(block(u(36), "page", { parent_table: "block", parent_id: u(1), properties: T(["Child B"]) }));
  add(block(u(40), "page", { parent_table: "block", parent_id: u(1), properties: T(["Child A"]), format: { page_icon: "attachment:aaaaaaaa-0000-4000-8000-000000000004:icon.png" } }));
  add(block(u(60), "collection_view", { parent_table: "block", parent_id: u(1), collection_id: u(100), view_ids: [u(200), u(201), u(202), u(203), u(204), u(205), u(206), u(207)], format: { collection_pointer: { id: u(100) } } }));
  add(block(u(80), "collection_view", { parent_table: "block", parent_id: u(1), collection_id: u(100), view_ids: [u(208)] }));
  add(block(u(90), "page", { parent_table: "space", parent_id: SPACE, properties: T(["Second root"]), content: [u(91)] }));
  add(block(u(91), "alias", { format: { alias_pointer: { id: u(40) } } }));
  const S = (id, title, props, extra = {}) => add(block(id, "page", { parent_table: "collection", parent_id: u(100), properties: { title: [[title]], ...props }, ...extra }));
  S(u(301), "Row one", { stat: [["Doing"]], sel: [["Red"]], tags: [["a,b"]], due: [["‣", [["d", { type: "date", start_date: "2026-03-01", end_date: "2026-03-04" }]]]], who: [["‣", [["u", ME]]]], ok: [["Yes"]], num: [["42"]], link: [["https://acme.test"]], txt: [["note"]], rel: [["‣", [["p", u(302)]]]], file: [["doc.pdf", [["a", "attachment:aaaaaaaa-0000-4000-8000-000000000003:doc.pdf"]]]] }, { format: { page_icon: "🚀", page_cover: "https://images.example.com/c.jpg" }, content: [u(310)] });
  S(u(302), "Row two", { stat: [["Done"]], sel: [["Blue"]], num: [["7"]] }, { last_edited_time: 1600000000000 });
  S(u(303), "Row three", { stat: [["Todo"]] });
  add(block(u(310), "text", { properties: T(["row body"]) }));
  const collections = {
    [u(100)]: wrap({
      id: u(100),
      name: [["Tasks"]],
      parent_id: u(60),
      parent_table: "block",
      icon: "📋",
      description: [["All the tasks"]],
      schema: {
        title: { name: "Task", type: "title" },
        stat: { name: "Status", type: "status", options: [{ id: "o1", value: "Todo", color: "gray" }, { id: "o2", value: "Doing", color: "blue" }, { id: "o3", value: "Done", color: "green" }], groups: [{ id: "g1", name: "To-do", optionIds: ["o1"] }, { id: "g2", name: "In progress", optionIds: ["o2"] }, { id: "g3", name: "Complete", optionIds: ["o3"] }] },
        sel: { name: "Colour", type: "select", options: [{ id: "s1", value: "Red", color: "red" }, { id: "s2", value: "Blue", color: "blue" }] },
        tags: { name: "Tags", type: "multi_select", options: [{ id: "m1", value: "a", color: "pink" }, { id: "m2", value: "b", color: "teal" }] },
        due: { name: "Due", type: "date" },
        who: { name: "Owner", type: "person" },
        ok: { name: "Ok", type: "checkbox" },
        num: { name: "Points", type: "number", number_format: "dollar" },
        link: { name: "Link", type: "url" },
        txt: { name: "Notes", type: "text" },
        ct: { name: "Created", type: "created_time" },
        et: { name: "Edited", type: "last_edited_time" },
        rel: { name: "Blocks", type: "relation", collection_id: u(100), property: "rel" },
        file: { name: "Files", type: "file" },
        f2: { name: "Big", type: "formula", formula2: { code: [["‣", [["fpp", { name: "Points", property: "num" }]]], [" > 10"]] } },
        f1: { name: "Double", type: "formula", formula: { type: "operator", name: "multiply", args: [{ type: "property", id: "num", name: "Points" }, { type: "constant", value: "2", value_type: "number" }] } },
        roll: { name: "Blocked points", type: "rollup", relation_property: "rel", target_property: "num", aggregation: "sum" },
        mail: { name: "Email", type: "rollup", rollup_type: "person", person_property: "who", target_property: "person:email", target_property_type: "email" },
      },
    }),
  };
  const V = (id, value) => [id, wrap({ id, alive: true, ...value })];
  const views = Object.fromEntries([
    V(u(200), { type: "table", name: "All", format: { table_wrap: true, table_frozen_column_index: 0, table_properties: [{ property: "title", width: 280, visible: true }, { property: "stat", visible: true, width: 120 }, { property: "txt", visible: false }], property_filters: [{ id: "pf1", filter: { property: "sel", filter: { operator: "enum_is", value: { type: "exact" } } } }] }, query2: { sort: [{ property: "num", direction: "descending" }], aggregations: [{ property: "num", aggregator: "sum" }], filter: { operator: "and", filters: [{ property: "ok", filter: { operator: "checkbox_is", value: { type: "exact", value: true } } }, { operator: "or", filters: [{ property: "stat", filter: { operator: "status_is", value: [{ type: "is_group", value: "In progress" }] } }, { property: "due", filter: { operator: "date_is_on_or_before", value: { type: "relative", value: "today" } } }] }] } } }),
    V(u(201), { type: "board", name: "Board", format: { collection_view_icon: "/icons/target_gray.svg", board_cover: { type: "page_cover" }, board_cover_size: "large", board_columns_by: { type: "status", property: "stat", groupBy: "option", sort: { type: "manual" }, hideEmptyGroups: true, disableBoardColorColumns: true }, board_columns: [{ property: "stat", value: { type: "status", value: { type: "by_option", option: "Done" } }, hidden: false }, { property: "stat", value: { type: "status", value: { type: "by_option", option: "Todo" } }, hidden: true }, { property: "stat", value: { type: "status" }, hidden: true }], board_properties: [{ property: "sel", visible: true }, { property: "num", visible: false }] } }),
    V(u(202), { type: "gallery", name: "Gallery", format: { gallery_cover: { type: "property", property: "file" }, gallery_cover_size: "small", gallery_cover_aspect: "contain", gallery_properties: [{ property: "title", visible: true }, { property: "sel", visible: true }] } }),
    V(u(203), { type: "list", name: "List", format: { list_properties: [{ property: "stat", visible: true }] } }),
    V(u(204), { type: "calendar", name: "Cal", query2: { calendar_by: "due" } }),
    V(u(205), { type: "timeline", name: "Time", format: { timeline_preference: { zoomLevel: "week" }, timeline_show_table: false, timeline_table_properties: [{ property: "title", width: 200, visible: true }] }, query2: { timeline_by: "due", timeline_by_end: "due" } }),
    V(u(206), { type: "chart", name: "Chart", format: { chart_config: { type: "donut", dataConfig: { groupBy: { property: "sel" }, aggregationConfig: { aggregation: { aggregator: "sum", property: "num" } } } } } }),
    V(u(207), { type: "form_editor", name: "Form", format: {} }),
    V(u(208), { type: "board", name: "Linked board", format: { board_columns_by: { type: "select", property: "sel" } } }),
  ]);
  const users = { [ME]: wrap({ id: ME, name: "Ada Lovelace", email: "ada@example.test" }) };
  return { spaceId: SPACE, rootIds: [u(1), u(90)], blocks, collections, views, users, rows: { [u(100)]: [u(302), u(301), u(303)] }, files: {} };
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

function withFiles(records) {
  const dir = mkdtempSync(join(tmpdir(), "notes-records-"));
  mkdirSync(join(dir, "files"));
  const put = (key, name, bytes) => {
    const path = `files/${name}`;
    writeFileSync(join(dir, path), bytes);
    records.files[key] = { path, name, size: bytes.length, version: `${name}:1` };
  };
  put("attachment:aaaaaaaa-0000-4000-8000-000000000001:pic.png", "pic.png", PNG);
  put("attachment:aaaaaaaa-0000-4000-8000-000000000002:a.m4a", "a.m4a", new Uint8Array([1, 2, 3]));
  put("attachment:aaaaaaaa-0000-4000-8000-000000000003:doc.pdf", "doc.pdf", new Uint8Array([37, 80, 68, 70]));
  put("attachment:aaaaaaaa-0000-4000-8000-000000000004:icon.png", "icon.png", new Uint8Array([...PNG, 1]));
  put("https://prod-files-secure.s3.us-west-2.amazonaws.com/x/y/report.csv", "report.csv", new TextEncoder().encode("a,b\n1,2\n"));
  put("/icons/gem_gray.svg", "gem_gray.svg", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"));
  put("https://images.example.com/c.jpg", "c.jpg", new Uint8Array([255, 216, 255, 0]));
  return dir;
}

async function imported(records = makeRecords()) {
  const dir = withFiles(records);
  const s = sinkFor();
  const { readFileSync } = await import("node:fs");
  const result = await M.importNotionRecords(records, s.sink, { read: async (p) => new Uint8Array(readFileSync(join(dir, p))) }, { workspace: "ws0000000001" });
  const byTitle = (t) => model.allPages(s.tree).find((p) => p.title === t);
  const blocksOf = (t) => M.readDoc(model.blocksOf(s.docs.get(byTitle(t).id)));
  const flat = (list, out = []) => {
    for (const b of list) {
      out.push(b);
      flat(b.children, out);
    }
    return out;
  };
  const blockById = (t, id) => flat(blocksOf(t)).find((b) => b.id === id.replace(/[^A-Za-z0-9_-]/g, ""));
  return { ...s, result, byTitle, blocksOf, blockById, flat };
}

test("unwraps nested record values and maps Notion colours, icons and covers", () => {
  assert.equal(M.unwrapNotionRecord({ value: { value: { id: "x", type: "text" } } }).type, "text");
  assert.equal(M.unwrapNotionRecord({ value: { role: "reader", value: { id: "y" } } }).id, "y");
  assert.deepEqual(M.notionColor("gray_background"), { backgroundColor: "gray" });
  assert.deepEqual(M.notionColor("teal"), { textColor: "green" });
  assert.deepEqual(M.notionColor("default"), {});
  assert.equal(M.notionIconEmoji("/icons/checkmark_green.svg"), "✅");
  assert.equal(M.notionIconEmoji("/images/icons/collection-table.84137af6.svg"), "🗂️");
  assert.equal(M.notionCoverFallback("/images/page-cover/solid_blue.png"), "color:4");
  assert.equal(M.notionCoverFallback("/images/page-cover/gradients_3.png"), "gradient:2");
  assert.equal(M.codeLanguage("Plain Text"), "text");
  assert.equal(M.codeLanguage("C++"), "cpp");
});

test("roots become top-level pages with icons, covers and page format, and one import record", async () => {
  const r = await imported();
  const top = model.childrenOf(r.tree, "");
  assert.deepEqual(top.map((p) => p.title), ["Home", "Second root"]);
  assert.deepEqual(r.result.roots, top.map((p) => p.id));
  const home = r.byTitle("Home");
  assert.equal(home.icon, "🏠");
  assert.equal(home.cover, "color:4");
  assert.equal(home.coverY, 75);
  assert.equal(home.fullWidth, true);
  assert.equal(home.createdAt, 1700000000000);
  assert.equal(home.updatedAt, 1700000500000);
  assert.match(r.byTitle("Child A").icon, /^file:[0-9a-f]{64}$/);
  M.recordImport(r.tree, { id: "job1", source: "notion", at: 5, roots: r.result.roots, by: "tester" });
  assert.equal(M.readImports(r.tree)[0].roots.length, 2);
  assert.deepEqual(M.undoImport(r.tree, "job1", "tester", 9).sort(), [...r.result.roots].sort());
  assert.equal(model.childrenOf(r.tree, "").length, 0);
  assert.equal(M.readImports(r.tree).length, 0);
});

test("sub-pages follow Notion content order, and a page linked from two places is imported once", async () => {
  const r = await imported();
  const home = r.byTitle("Home");
  const kids = model.childrenOf(r.tree, home.id).map((p) => p.title);
  assert.deepEqual(kids.filter((t) => t.startsWith("Child")), ["Child B", "Child A"]);
  assert.equal(model.allPages(r.tree).filter((p) => p.title === "Child A").length, 1);
  const subpages = r.flat(r.blocksOf("Home")).filter((b) => b.type === "subpage");
  assert.deepEqual(subpages.map((b) => b.props.pageId), [r.byTitle("Child B").id, r.byTitle("Child A").id]);
});

test("headings, toggles, lists, to-dos, quotes, callouts, code and dividers keep their format", async () => {
  const r = await imported();
  const get = (n) => r.blockById("Home", u(n));
  assert.deepEqual([get(2).type, get(2).props.level ?? 1, get(2).props.textColor], ["heading", 1, "blue"]);
  assert.deepEqual([get(3).props.level, get(3).props.isToggleable, get(3).children[0].content[0].text], [2, true, "inside"]);
  assert.equal(get(4).props.level, 3);
  assert.equal(get(5).props.level, 4);
  assert.equal(get(8).type, "bulletListItem");
  assert.equal(get(8).children[0].type, "bulletListItem");
  assert.deepEqual([get(9).type, get(9).props.start], ["numberedListItem", 3]);
  assert.deepEqual([get(10).type, get(10).props.checked], ["checkListItem", true]);
  assert.deepEqual([get(11).type, get(11).children.length], ["toggleListItem", 1]);
  assert.equal(get(12).type, "quote");
  assert.equal(get(13).type, "callout");
  assert.match(get(13).props.icon, /^file:[0-9a-f]{64}$/);
  assert.equal(get(13).props.backgroundColor, "gray");
  assert.deepEqual([get(14).type, get(14).props.language, get(14).props.wrap, get(14).content[0].text], ["codeBlock", "typescript", true, "const a = 1"]);
  assert.equal(get(15).type, "divider");
  assert.deepEqual([get(28).type, get(28).content[0].text], ["equation", "E=mc^2"]);
  assert.equal(get(32).type, "toc");
  assert.equal(get(34).type, "paragraph");
  assert.equal(r.flat(r.blocksOf("Home")).find((b) => b.content?.[0]?.text === "synced")?.type, "paragraph");
});

test("inline annotations map to styles, links and mentions", async () => {
  const r = await imported();
  const p = r.blockById("Home", u(6));
  assert.equal(p.props.backgroundColor, "gray");
  const parts = Object.fromEntries(p.content.map((c) => [c.type === "link" ? c.content[0].text : c.text, c]));
  assert.deepEqual(parts.b.styles, { bold: true });
  assert.deepEqual(parts.i.styles, { italic: true });
  assert.deepEqual(parts.s.styles, { strike: true });
  assert.deepEqual(parts.c.styles, { code: true });
  assert.deepEqual(parts.u.styles, { underline: true });
  assert.equal(parts.link.href, "https://example.com");
  assert.deepEqual(parts.red.styles, { textColor: "red" });
  assert.deepEqual(parts.hl.styles, { backgroundColor: "yellow" });
  const m = r.blockById("Home", u(7)).content;
  const childA = r.byTitle("Child A").id;
  assert.deepEqual(m[0], { type: "mention", props: { kind: "page", pageId: childA } });
  assert.equal(m.find((c) => c.type === "mention" && c.props.kind === "user").props.name, "Ada Lovelace");
  assert.equal(m.find((c) => c.type === "mention" && c.props.kind === "date").props.date, "2026-01-02");
  assert.equal(m.find((c) => c.type === "inlineEquation").content, "x^2");
  const links = m.filter((c) => c.type === "link");
  assert.deepEqual(links.map((l) => l.content[0].text), ["Docs page", "github.com › pull/7", "inner"]);
  assert.equal(links[0].href, "https://docs.example.com/a");
  assert.equal(links[1].href, "https://github.com/acme/repo/pull/7");
  assert.equal(links[2].href, `ardia://notes/Child-A-${childA}`);
  assert.deepEqual(r.blockById("Home", u(31)).props, { pageId: childA });
});

test("media, files and embeds keep their sources, names, captions and widths", async () => {
  const r = await imported();
  const get = (n) => r.blockById("Home", u(n));
  assert.match(get(16).props.url, /^file:[0-9a-f]{64}$/);
  assert.deepEqual([get(16).type, get(16).props.name, get(16).props.caption, get(16).props.previewWidth], ["image", "pic.png", "A caption", 320]);
  assert.deepEqual([get(17).type, get(17).props.url], ["video", "https://cdn.example.com/v.mp4"]);
  assert.match(get(18).props.url, /^file:/);
  assert.deepEqual([get(19).type, get(19).props.name], ["file", "doc.pdf"]);
  assert.match(get(19).props.url, /^file:/);
  assert.deepEqual([get(20).type, get(20).props.name], ["file", "report.csv"]);
  assert.match(get(20).props.url, /^file:/);
  assert.deepEqual([get(21).type, get(21).props.url], ["embed", "https://maps.example.com/embed"]);
  assert.equal(get(22).type, "embed");
  assert.equal(get(23).type, "embed");
  assert.deepEqual([get(29).type, get(29).props.url], ["bookmark", "https://example.org"]);
  assert.match(get(33).props.url, /^file:/);
  assert.ok(r.result.attachments >= 6);
});

test("tables keep column order, widths, header rows and cell colours; columns keep their widths", async () => {
  const r = await imported();
  const t = r.blockById("Home", u(24));
  assert.equal(t.type, "table");
  assert.equal(t.content.headerRows, 1);
  assert.deepEqual(t.content.columnWidths.slice(0, 1), [180]);
  assert.deepEqual(t.content.rows.map((row) => row.cells.map((c) => c.content.map((x) => x.text).join(""))), [["H1", "H2"], ["c1", "c2"]]);
  assert.deepEqual(t.content.rows[0].cells[1].content[0].styles, { bold: true });
  assert.equal(t.content.rows[0].cells[0].props.backgroundColor, "blue");
  assert.equal(t.content.rows[1].cells[1].props.textColor, "red");
  const cols = r.blockById("Home", u(25));
  assert.equal(cols.type, "columnList");
  assert.deepEqual(cols.children.map((c) => c.props.width), [0.5, 1.5]);
  assert.equal(cols.children[1].children[0].type, "callout");
  assert.equal(cols.children[1].children[0].props.icon, "👋");
});

test("AI blocks, external objects and unknown blocks fall back instead of vanishing", async () => {
  const r = await imported();
  const ai = r.blockById("Home", u(26));
  assert.equal(ai.type, "callout");
  assert.equal(ai.props.icon, "✨");
  assert.equal(ai.children[0].content[0].text, "summary text");
  assert.deepEqual([r.blockById("Home", u(27)).type, r.blockById("Home", u(27)).props.url], ["bookmark", "https://github.com/acme/repo"]);
  const odd = r.blockById("Home", u(30));
  assert.equal(odd.type, "paragraph");
  assert.match(odd.content.map((c) => c.text).join(""), /mystery block.*odd/);
});

test("databases map every property type with options, colours, status groups and stored values", async () => {
  const r = await imported();
  const db = model.allPages(r.tree).find((p) => p.kind === "database" && !p.props.linkedSource);
  assert.equal(db.title, "Tasks");
  assert.equal(db.icon, "📋");
  assert.equal(db.props.inline, true);
  const doc = r.docs.get(db.id);
  const schema = D.readSchema(doc);
  const by = Object.fromEntries(schema.map((p) => [p.name, p]));
  assert.equal(by.Task.type, "title");
  assert.deepEqual(Object.fromEntries(Object.values(by).map((p) => [p.name, p.type])), { Task: "title", Status: "status", Colour: "select", Tags: "multi_select", Due: "date", Owner: "person", Ok: "checkbox", Points: "number", Link: "url", Notes: "text", Created: "created_time", Edited: "edited_time", Blocks: "relation", Files: "files", Big: "formula", Double: "formula", "Blocked points": "rollup", Email: "email" });
  assert.deepEqual(by.Status.options.map((o) => [o.name, o.color, o.group]), [["Todo", "gray", "todo"], ["Doing", "blue", "doing"], ["Done", "green", "done"]]);
  assert.deepEqual(by.Tags.options.map((o) => o.color), ["pink", "green"]);
  assert.equal(by.Points.format, "dollar");
  assert.equal(D.readSettings(doc).description, "All the tasks");
  const rows = D.databaseRows(r.tree, db.id);
  assert.deepEqual(rows.map((p) => p.title), ["Row two", "Row one", "Row three"]);
  const one = rows[1];
  assert.equal(one.icon, "🚀");
  assert.match(one.cover, /^file:/);
  assert.equal(D.selectValue(one, by.Status).name, "Doing");
  assert.equal(D.selectValue(one, by.Colour).name, "Red");
  assert.deepEqual(D.multiValue(one, by.Tags).map((o) => o.name), ["a", "b"]);
  assert.deepEqual(one.props[by.Due.id], { start: "2026-03-01", end: "2026-03-04" });
  assert.equal(one.props[by.Ok.id], true);
  assert.equal(one.props[by.Points.id], 42);
  assert.equal(one.props[by.Link.id], "https://acme.test");
  assert.deepEqual(one.props[by.Blocks.id], [rows[0].id]);
  assert.equal(one.props[by.Files.id][0].name, "doc.pdf");
  assert.match(one.props[by.Files.id][0].ref, /^file:/);
  assert.equal(D.readPeople(doc)[0].name, "Ada Lovelace");
  assert.equal(rows[0].updatedAt, 1600000000000);
  assert.equal(M.readDoc(model.blocksOf(r.docs.get(one.id)))[0].content[0].text, "row body");
  assert.equal(by.Blocks.relation, db.id);
  assert.equal(by.Blocks.twoWay, true);
  const ctx = D.makeContext({ database: db.id, schema, rows, page: (id) => model.getPage(r.tree, id), schemaFor: () => schema, rowsFor: (id) => D.databaseRows(r.tree, id), people: new Map() });
  assert.equal(by.Big.expression, 'prop("Points") > 10');
  assert.equal(D.formulaValue(ctx, one, by.Big), true);
  assert.equal(D.formulaValue(ctx, one, by.Double), 84);
  assert.equal(by["Blocked points"].rollupRelation, by.Blocks.id);
  assert.equal(by["Blocked points"].rollupTarget, by.Points.id);
  assert.equal(D.rollupValue(ctx, one, by["Blocked points"]), 7);
});

test("views keep type, name, order, properties, widths, sorts, filters, groups, covers and dates", async () => {
  const r = await imported();
  const db = model.allPages(r.tree).find((p) => p.kind === "database" && !p.props.linkedSource);
  const doc = r.docs.get(db.id);
  const schema = D.readSchema(doc);
  const id = (name) => schema.find((p) => p.name === name).id;
  const views = D.readViews(doc);
  assert.deepEqual(views.map((v) => [v.type, v.name]), [["table", "All"], ["board", "Board"], ["gallery", "Gallery"], ["list", "List"], ["calendar", "Cal"], ["timeline", "Time"], ["chart", "Chart"], ["form", "Form"]]);
  const [table, board, gallery, list, cal, time, chart, form] = views;
  assert.equal(table.wrap, true);
  assert.equal(table.frozen, 1);
  assert.deepEqual([table.props[D.TITLE].width, table.props[id("Status")].width, table.props[id("Notes")].visible], [280, 120, false]);
  assert.ok(table.props[D.TITLE].order < table.props[id("Status")].order);
  assert.deepEqual(table.sorts.map((s) => [s.prop, s.dir]), [[id("Points"), "desc"]]);
  assert.equal(table.calcs[id("Points")], "sum");
  const rules = table.filter.rules;
  assert.deepEqual([rules[0].prop, rules[0].cond], [id("Ok"), "checked"]);
  assert.equal(rules[1].kind, "group");
  assert.equal(rules[1].op, "or");
  const doing = schema.find((p) => p.name === "Status").options.find((o) => o.name === "Doing").id;
  assert.deepEqual(rules[1].rules[0].value, [doing]);
  assert.deepEqual(rules[1].rules[1].value, { relative: "today" });
  assert.equal(rules[1].rules[1].cond, "on_or_before");
  assert.equal(rules[2].prop, id("Colour"));
  assert.equal(rules[2].value, undefined);
  assert.equal(board.groupBy.prop, id("Status"));
  assert.equal(board.groupBy.hideEmpty, true);
  assert.equal(board.colorColumns, false);
  assert.equal(board.cardPreview, "cover");
  assert.equal(board.cardSize, "large");
  assert.match(board.icon, /^(file:|🎯)/);
  const done = schema.find((p) => p.name === "Status").options.find((o) => o.name === "Done").id;
  const todo = schema.find((p) => p.name === "Status").options.find((o) => o.name === "Todo").id;
  assert.equal(board.groups[todo].hidden, true);
  assert.equal(board.groups[D.NONE].hidden, true);
  assert.ok(board.groups[done].order < board.groups[todo].order);
  assert.deepEqual([board.props[id("Colour")].visible, board.props[id("Points")].visible], [true, false]);
  assert.deepEqual([gallery.cardPreview, gallery.cardSize, gallery.fitImage], [id("Files"), "small", true]);
  assert.equal(list.props[id("Status")].visible, true);
  assert.equal(cal.dateProp, id("Due"));
  assert.deepEqual([time.dateProp, time.endProp, time.zoom, time.showTable, time.props[D.TITLE].width], [id("Due"), id("Due"), "week", false, 200]);
  assert.deepEqual([chart.chartType, chart.chartBy, chart.chartAgg, chart.chartValue], ["donut", id("Colour"), "sum", id("Points")]);
  assert.ok(form.formFields.some((f) => f.prop === D.TITLE && f.required));
  assert.ok(D.formFieldsFor(form, schema).length >= 5);
  const ctx = D.makeContext({ database: db.id, schema, rows: D.databaseRows(r.tree, db.id), page: (x) => model.getPage(r.tree, x), schemaFor: () => schema, people: new Map() });
  assert.deepEqual(D.computeView(ctx, table).rows.map((p) => p.title), ["Row one"]);
});

test("a second view of the same data source becomes a linked database with its own views", async () => {
  const r = await imported();
  const source = model.allPages(r.tree).find((p) => p.kind === "database" && !p.props.linkedSource);
  const linked = model.allPages(r.tree).find((p) => p.kind === "database" && p.props.linkedSource);
  assert.equal(linked.props.linkedSource, source.id);
  assert.equal(D.readSettings(r.docs.get(linked.id)).source, source.id);
  const views = D.readViews(r.docs.get(linked.id));
  assert.deepEqual(views.map((v) => [v.type, v.name]), [["board", "Linked board"]]);
  assert.equal(views[0].groupBy.prop, D.readSchema(r.docs.get(source.id)).find((p) => p.name === "Colour").id);
  const dbBlocks = r.flat(r.blocksOf("Home")).filter((b) => b.type === "database");
  assert.deepEqual(dbBlocks.map((b) => b.props.database), [source.id, linked.id]);
  assert.equal(D.databaseRows(r.tree, linked.id).length, 0);
});

test("the importer answers a folder holding notion-records.json through the import job", async () => {
  const records = makeRecords();
  const dir = withFiles(records);
  writeFileSync(join(dir, M.RECORDS_FILE), JSON.stringify(records));
  const data = mkdtempSync(join(tmpdir(), "notes-records-data-"));
  const files = M.nodeFiles({ data });
  cleanups.push(() => files.detach());
  const grant = M.grantFor(files, "precordtest01", dir, "export");
  const storage = new Map();
  const hub = M.pageHub();
  const notes = new M.Notes({ files, folders: M.fakeFolders(files, join(data, "..", "shared-x"), [grant]), storage: { get: async (k) => structuredClone(storage.get(k)), set: async (k, v) => void storage.set(k, structuredClone(v)) }, setting: () => "", post: hub.post, openPage: async () => {}, openUrl: async () => {}, store: { debounceMs: 20, rescanMs: 60000 } });
  hub.attach(notes);
  cleanups.push(() => notes.stop());
  await notes.start();
  const ws = notes.workspaces()[0].id;
  const started = await notes.call("importStart", { workspace: ws, source: "notion", pick: "folder" });
  const job = await until(async () => {
    const j = await notes.call("importStatus", { job: started.job });
    return j.state === "done" || j.state === "failed" ? j : null;
  }, 20_000, "records import");
  assert.equal(job.state, "done", job.error);
  assert.equal(job.roots.length, 2);
  assert.equal(job.databases, 2);
  const tree = await notes.tree(notes.spaces.get(ws));
  const titles = model.childrenOf(tree, "").map((p) => p.title);
  assert.ok(titles.includes("Home") && titles.includes("Second root"));
  assert.ok(!titles.some((t) => /import/i.test(t)));
  assert.equal(Object.keys(tree.getMap("imports").toJSON()).length, 1);
});

test("an empty status takes the status's default option, and cards keep their title as Notion does", async () => {
  const records = makeRecords();
  const coll = records.collections[u(100)].value.value;
  coll.schema.stat.defaultOption = "Doing";
  delete records.blocks[u(303)].value.value.properties.stat;
  records.views[u(201)].value.value.format.board_properties.push({ property: "title", visible: false });
  const r = await imported(records);
  const db = model.allPages(r.tree).find((p) => p.kind === "database" && !p.props.linkedSource);
  const schema = D.readSchema(r.docs.get(db.id));
  const status = schema.find((p) => p.name === "Status");
  const three = D.databaseRows(r.tree, db.id).find((p) => p.title === "Row three");
  assert.equal(D.selectValue(three, status).name, "Doing");
  const board = D.readViews(r.docs.get(db.id)).find((v) => v.type === "board");
  assert.equal(board.props[D.TITLE].visible, true);
});

test("files without an extension get one from their bytes", () => {
  assert.equal(M.sniffExt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(M.sniffExt(PNG), "png");
  assert.equal(M.sniffExt(new TextEncoder().encode("<svg xmlns='x'/>")), "svg");
  assert.equal(M.sniffExt(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41])), "m4a");
  assert.equal(M.sniffExt(new Uint8Array([1, 2, 3])), null);
});

test("pages another device deletes for good leave this device's search index", async () => {
  const data = mkdtempSync(join(tmpdir(), "notes-index-"));
  const shared = new Map();
  const make = (deviceId) => {
    const files = M.nodeFiles({ data });
    const storage = new Map([...shared, ["deviceId", deviceId]]);
    const hub = M.pageHub();
    const notes = new M.Notes({ files, folders: M.fakeFolders(files, join(data, "..", `shared-${deviceId}`), []), storage: { get: async (k) => structuredClone(storage.get(k)), set: async (k, v) => void storage.set(k, structuredClone(v)) }, setting: () => "", post: hub.post, openPage: async () => {}, openUrl: async () => {}, store: { debounceMs: 5, rescanMs: 30 } });
    hub.attach(notes);
    cleanups.push(async () => {
      await notes.stop();
      files.detach();
    });
    return { notes, storage };
  };
  const a = make("aaaaaaaaaaaaaaa1");
  await a.notes.start();
  const ws = a.notes.workspaces()[0].id;
  for (const k of ["workspaces", "me"]) shared.set(k, a.storage.get(k));
  const b = make("bbbbbbbbbbbbbbb2");
  await b.notes.start();
  const { page } = await b.notes.call("createPage", { workspace: ws, parent: "", kind: "page", title: "Zanzibar ledger" });
  await until(async () => (await a.notes.call("search", { workspace: ws, query: "Zanzibar" })).some((h) => h.page === page), 10_000, "a sees the new page");
  await b.notes.call("deletePage", { workspace: ws, page });
  await until(async () => !(await a.notes.call("search", { workspace: ws, query: "Zanzibar" })).some((h) => h.page === page), 10_000, "a drops the deleted page");
});

test("pages in Notion's trash, or under a page in it, are left out", async () => {
  const records = makeRecords();
  const add = (b) => (records.blocks[b.id] = wrap(b));
  add(block(u(500), "page", { alive: false, parent_table: "space", parent_id: SPACE, properties: { title: [["Poke"]] }, content: [u(501)] }));
  add(block(u(501), "page", { parent_table: "block", parent_id: u(500), properties: { title: [["Memory hub"]] }, content: [u(502)] }));
  add(block(u(502), "page", { parent_table: "block", parent_id: u(501), properties: { title: [["Under the hub"]] } }));
  add(block(u(503), "page", { alive: false, parent_table: "block", parent_id: u(1), properties: { title: [["Binned child"]] } }));
  records.blocks[u(1)].value.value.content.push(u(503));
  records.rootIds.push(u(501));
  const r = await imported(records);
  const titles = model.allPages(r.tree).map((p) => p.title);
  for (const gone of ["Poke", "Memory hub", "Under the hub", "Binned child"]) assert.ok(!titles.includes(gone), gone);
  assert.deepEqual(model.childrenOf(r.tree, "").map((p) => p.title), ["Home", "Second root"]);
  assert.ok(!r.flat(r.blocksOf("Home")).some((b) => b.type === "subpage" && !model.getPage(r.tree, b.props.pageId)));
});

test("importing the same workspace again keeps every page's id and updates it in place, like a sync", async () => {
  const records = makeRecords();
  const dir = withFiles(records);
  const { readFileSync } = await import("node:fs");
  const s = sinkFor();
  s.sink.doc = async (page) => s.docs.get(page) ?? s.sink.newDoc(page);
  const reader = { read: async (p) => new Uint8Array(readFileSync(join(dir, p))) };
  const first = await M.importNotionRecords(records, s.sink, reader, { workspace: "ws0000000001" });
  M.recordImport(s.tree, { id: M.notionRecordId(records.spaceId), source: "notion", at: 1, roots: first.roots, pages: first.pageIds, by: "tester" });
  const before = new Map(model.allPages(s.tree).map((p) => [p.title, p.id]));
  const homeDoc = s.docs.get(before.get("Home"));
  const db = model.allPages(s.tree).find((p) => p.kind === "database" && !p.props.linkedSource);
  const viewIds = D.readViews(s.docs.get(db.id)).map((v) => v.id);
  const propIds = D.readSchema(s.docs.get(db.id)).map((p) => p.id);
  const again = makeRecords();
  again.files = records.files;
  again.blocks[u(1)].value.value.properties.title = [["Home, renamed"]];
  again.blocks[u(2)].value.value.properties.title = [["Bigger"]];
  again.blocks[u(1)].value.value.content = again.blocks[u(1)].value.value.content.filter((c) => c !== u(36));
  delete again.blocks[u(36)];
  const second = await M.importNotionRecords(again, s.sink, reader, { workspace: "ws0000000001" });
  assert.deepEqual(second.roots, first.roots);
  const home = model.getPage(s.tree, before.get("Home"));
  assert.equal(home.title, "Home, renamed");
  assert.equal(s.docs.get(home.id), homeDoc, "the open page's doc is updated, not replaced");
  assert.equal(M.readDoc(model.blocksOf(homeDoc)).find((b) => b.id === u(2).replace(/-/g, "") || b.id === u(2))?.content[0].text, "Bigger");
  assert.equal(model.getPage(s.tree, before.get("Child A")).archivedAt, 0);
  assert.ok(model.getPage(s.tree, before.get("Child B")).archivedAt > 0, "a page gone from Notion moves to the trash");
  assert.equal(second.archived, 1);
  assert.deepEqual(D.readViews(s.docs.get(db.id)).map((v) => v.id), viewIds);
  assert.deepEqual(D.readSchema(s.docs.get(db.id)).map((p) => p.id), propIds);
  const rows = D.databaseRows(s.tree, db.id);
  assert.deepEqual(rows.map((p) => p.title), ["Row two", "Row one", "Row three"]);
  assert.equal(model.allPages(s.tree).filter((p) => p.title === "Row one").length, 1);
  const other = await M.importNotionRecords(makeRecords(), sinkFor().sink, reader, { workspace: "ws0000000002" });
  assert.notEqual(other.roots[0], first.roots[0], "ids are scoped to the workspace");
});

test("a records import reads no Yjs type before it joins a document, so it logs no premature-access warnings", async () => {
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(String(args[0]));
  try {
    const records = makeRecords();
    const dir = withFiles(records);
    const { readFileSync } = await import("node:fs");
    const s = sinkFor();
    s.sink.doc = async (page) => s.docs.get(page) ?? s.sink.newDoc(page);
    const reader = { read: async (p) => new Uint8Array(readFileSync(join(dir, p))) };
    await M.importNotionRecords(records, s.sink, reader, { workspace: "ws0000000001" });
    await M.importNotionRecords(records, s.sink, reader, { workspace: "ws0000000001" });
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warned.filter((w) => /Yjs/.test(w)), []);
});

test("importing again skips reading attachments it already stored, and reads any that changed size", async () => {
  const records = makeRecords();
  const dir = withFiles(records);
  const { readFileSync, writeFileSync: write } = await import("node:fs");
  const s = sinkFor();
  s.sink.doc = async (page) => s.docs.get(page) ?? s.sink.newDoc(page);
  s.sink.hasFile = async (sha, size) => s.stored.get(sha)?.bytes.length === size;
  const reads = [];
  const reader = { read: async (p) => (reads.push(p), new Uint8Array(readFileSync(join(dir, p)))) };
  const first = await M.importNotionRecords(records, s.sink, reader, { workspace: "ws0000000001" });
  assert.ok(reads.length >= 5);
  assert.equal(Object.keys(first.files).length, new Set(reads).size);
  reads.length = 0;
  const second = await M.importNotionRecords(records, s.sink, reader, { workspace: "ws0000000001", files: first.files });
  assert.deepEqual(reads, [], "nothing is read again");
  assert.equal(second.attachments, first.attachments);
  assert.deepEqual(second.files, first.files);
  const home = model.allPages(s.tree).find((p) => p.title === "Home");
  const image = M.readDoc(model.blocksOf(s.docs.get(home.id))).find((b) => b.type === "image");
  assert.match(image.props.url, /^file:[0-9a-f]{64}$/);
  const key = "attachment:aaaaaaaa-0000-4000-8000-000000000001:pic.png";
  write(join(dir, records.files[key].path), new Uint8Array([...PNG, 9, 9]));
  records.files[key].size = PNG.length + 2;
  reads.length = 0;
  await M.importNotionRecords(records, s.sink, reader, { workspace: "ws0000000001", files: first.files });
  assert.deepEqual(reads, [records.files[key].path], "only the changed attachment is read");
  M.recordImport(s.tree, { id: "notion-x", source: "notion", at: 1, roots: first.roots, pages: first.pageIds, by: "tester", files: first.files });
  assert.deepEqual(M.readImports(s.tree)[0].files, first.files, "the import record keeps the attachment marks");
});
