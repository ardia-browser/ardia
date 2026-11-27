import { archivePage, blocksOf, createPage, updatePage } from "../../shared/model";
import { pageDocId, treeDocId } from "../../shared/protocol";
import type { MockSeedApi } from "./mock";
import { writeBlocks } from "../editor/ops";

type B = Record<string, unknown>;
const p = (text: string | unknown[], props: B = {}): B => ({ type: "paragraph", content: text, props });
const h = (level: number, text: string, props: B = {}): B => ({ type: "heading", props: { level, ...props }, content: text });
const todo = (text: string, checked = false): B => ({ type: "checkListItem", props: { checked }, content: text });
const bullet = (text: string | unknown[], children: B[] = []): B => ({ type: "bulletListItem", content: text, children });
const num = (text: string): B => ({ type: "numberedListItem", content: text });

export async function seedWorkspaces(api: MockSeedApi) {
  const personal = "a1b2c3d4e5f6";
  const team = "f6e5d4c3b2a1";
  api.addWorkspace({ id: personal, name: "Personal", icon: "", shared: false, folderId: null });
  api.addWorkspace({ id: team, name: "Ardia Team", icon: "🛰️", shared: true, folderId: "folder-team" });
  const by = api.me.deviceId;
  const tree = api.doc(personal, treeDocId);
  const teamTree = api.doc(team, treeDocId);
  const now = Date.now();
  const write = (ws: string, page: string, blocks: B[]) => writeBlocks(blocksOf(api.doc(ws, pageDocId(page))), blocks);

  const ids = {
    start: "5a17a2700001",
    quick: "5a17a2700002",
    meeting: "5a17a2700003",
    reading: "5a17a2700004",
    trip: "5a17a2700005",
    packing: "5a17a2700006",
    weekly: "5a17a2700007",
    draft: "5a17a2700008",
    roadmap: "5a17a2700009",
    handbook: "5a17a270000a",
  };
  createPage(tree, { id: ids.start, parent: "", kind: "page", title: "Getting Started", icon: "👋", by, now: now - 86400000 * 3 });
  createPage(tree, { id: ids.quick, parent: ids.start, kind: "page", title: "Quick Note", icon: "📝", by, now: now - 86400000 * 2 });
  createPage(tree, { id: ids.meeting, parent: "", kind: "page", title: "Meeting Notes", icon: "🗓️", by, now: now - 3600000 * 5 });
  createPage(tree, { id: ids.reading, parent: "", kind: "page", title: "Reading List", icon: "📚", by, now: now - 3600000 * 30 });
  createPage(tree, { id: ids.trip, parent: "", kind: "page", title: "Trip to Lisbon", icon: "✈️", by, now: now - 86400000 * 6 });
  createPage(tree, { id: ids.packing, parent: ids.trip, kind: "page", title: "Packing List", icon: "🧳", by, now: now - 86400000 * 6 });
  createPage(tree, { id: ids.weekly, parent: "", kind: "page", title: "Weekly Review", icon: "📋", by, now: now - 86400000 * 9 });
  updatePage(tree, ids.weekly, { isTemplate: true }, by);
  createPage(tree, { id: ids.draft, parent: "", kind: "page", title: "Old draft", icon: "🗑️", by, now: now - 86400000 * 20 });
  archivePage(tree, ids.draft, by, now - 86400000);
  updatePage(tree, ids.start, { cover: "gradient:3" }, by);

  createPage(teamTree, { id: ids.roadmap, parent: "", kind: "page", title: "Roadmap", icon: "🗺️", by: "dev-grace", now: now - 86400000 });
  createPage(teamTree, { id: ids.handbook, parent: "", kind: "page", title: "Team Handbook", icon: "🤝", by: "dev-grace", now: now - 86400000 * 4 });

  write(personal, ids.start, [
    { type: "callout", props: { icon: "💡", backgroundColor: "default" }, content: "Welcome to Notes. Pages are made of blocks — text, lists, to-dos, code, equations and more. Everything stays on this Mac, and shared workspaces sync through iCloud Drive." },
    { type: "toc" },
    h(2, "The basics"),
    todo("Click anywhere and just start typing", true),
    todo("Press / to see every kind of block you can add"),
    todo("Select any text to bold it, add a link, a comment or a colour"),
    todo("See ⋮⋮ to the left of this line when you hover? Drag it to move the block"),
    todo("Click + New page in the sidebar to add a page"),
    { type: "toggleListItem", content: "Click the ▸ to open this toggle", children: [p("Toggles hide content until you need it. Drag blocks inside to nest them.")] },
    h(2, "Blocks you can use"),
    bullet("Bulleted lists for loose ideas", [bullet("…and nested ones with Tab")]),
    num("Numbered lists for steps"),
    num("They count by themselves"),
    { type: "quote", content: "“The best way to predict the future is to invent it.” — Alan Kay" },
    { type: "codeBlock", props: { language: "typescript" }, content: 'const greet = (name: string) => `Hello, ${name}!`;\nconsole.log(greet("Notes"));' },
    { type: "equation", content: "e^{i\\pi} + 1 = 0" },
    { type: "divider" },
    h(3, "Links between pages"),
    p([{ type: "text", text: "Type ", styles: {} }, { type: "text", text: "@", styles: { code: true } }, { type: "text", text: " to mention a page like ", styles: {} }, { type: "mention", props: { kind: "page", pageId: ids.meeting } }, { type: "text", text: ", or ", styles: {} }, { type: "text", text: "[[", styles: { code: true } }, { type: "text", text: " to link one.", styles: {} }]),
    { type: "subpage", props: { pageId: ids.quick } },
    p(""),
  ]);
  write(personal, ids.quick, [p("A quick thought, saved for later.")]);
  write(personal, ids.meeting, [
    h(2, "Agenda"),
    bullet("Review last week"),
    bullet([{ type: "text", text: "Read ", styles: {} }, { type: "mention", props: { kind: "page", pageId: ids.start } }, { type: "text", text: " before the call", styles: {} }]),
    h(2, "Action items"),
    todo("Send the summary"),
    todo("Book the next meeting"),
  ]);
  write(personal, ids.reading, [bullet("The Dream Machine — M. Mitchell Waldrop"), bullet("Where Wizards Stay Up Late"), bullet("The Soul of a New Machine")]);
  write(personal, ids.trip, [p("Flights, stays and things to see."), { type: "subpage", props: { pageId: ids.packing } }]);
  write(personal, ids.packing, [todo("Passport"), todo("Adapter"), todo("Sunscreen")]);
  write(personal, ids.weekly, [h(2, "Wins"), bullet(""), h(2, "Lessons"), bullet(""), h(2, "Next week"), todo("")]);
  write(personal, ids.draft, [p("Something I no longer need.")]);
  write(team, ids.roadmap, [h(2, "Now"), bullet("Notes plugin"), h(2, "Next"), bullet("Databases everywhere")]);
  write(team, ids.handbook, [p("How we work together.")]);
}
