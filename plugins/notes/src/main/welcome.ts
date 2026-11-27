import type * as Y from "yjs";
import { writeBlocks, type BlockSpec, type Inline } from "../shared/blocks";
import { initDatabase } from "../shared/database";
import { createPage, metaOf } from "../shared/model";

export { writeBlocks, type BlockSpec, type Inline };

const p = (...content: Inline[]): BlockSpec => ({ type: "paragraph", content });
const h = (level: number, text: string): BlockSpec => ({ type: "heading", attrs: { level }, content: [text] });
const todo = (text: string, checked = false): BlockSpec => ({ type: "checkListItem", attrs: { checked }, content: [text] });
const bullet = (...content: Inline[]): BlockSpec => ({ type: "bulletListItem", content });
const b = (text: string): Inline => ({ text, marks: { bold: {} } });
const code = (text: string): Inline => ({ text, marks: { code: {} } });

export const GETTING_STARTED: BlockSpec[] = [
  p("Welcome to Notes. Everything here lives on this Mac, and a shared workspace syncs through iCloud Drive with the people you invite."),
  h(2, "The basics"),
  todo("Click anywhere and just start typing", true),
  todo("Press / for headings, lists, tables, images and more"),
  todo("Drag the ⋮⋮ handle to move a block"),
  todo("Type [[ or + to link to another page"),
  todo("Press ⌘K to find any note, or search from the command bar"),
  h(2, "Blocks you can use"),
  { type: "toggleListItem", content: ["Toggles hide details until you need them"], children: [p("Like this. Click the arrow again to fold it away.")] },
  { type: "callout", attrs: { icon: "💡" }, content: ["Callouts make a note stand out. Change the emoji by clicking it."] },
  { type: "quote", content: ["Quotes set words apart from the rest of the page."] },
  { type: "codeBlock", attrs: { language: "javascript" }, content: ['const greeting = "Hello from Notes";\nconsole.log(greeting);'] },
  { type: "divider" },
  h(3, "Text styles"),
  p("Select text to make it ", b("bold"), ", ", { text: "italic", marks: { italic: {} } }, ", ", code("code"), " or a link."),
  bullet("Type ", code("#"), " and a space for a heading, ", code("-"), " for a list, ", code("[]"), " for a to-do"),
  bullet("Type ", code(">"), " for a toggle, ", code('"'), " for a quote, ", code("```"), " for code"),
  h(2, "Pages inside pages"),
  p("Any page can hold more pages. Open the sidebar to see them as a tree, and drag pages to reorder or nest them."),
];

export function seedWelcome(tree: Y.Doc, by: string, open: (pageId: string) => Y.Doc, now = Date.now()): { first: string; pages: string[] } {
  metaOf(tree).set("name", "My Notes");
  const first = createPage(tree, { parent: "", kind: "page", title: "Getting Started", icon: "👋", by, now });
  writeBlocks(open(first), GETTING_STARTED);
  const tasks = createPage(tree, { parent: "", kind: "database", title: "Tasks", icon: "✅", by, now });
  initDatabase(open(tasks), { title: "All tasks" });
  for (const title of ["Read Getting Started", "Make a page of your own", "Share a workspace with someone"]) createPage(tree, { parent: tasks, kind: "page", title, by, now });
  const ideas = createPage(tree, { parent: "", kind: "page", title: "Ideas", icon: "💭", by, now });
  writeBlocks(open(ideas), [p("Jot down anything here. Press / to add a block, or + to start a page inside this one.")]);
  const sub = createPage(tree, { parent: ideas, kind: "page", title: "Reading list", icon: "📚", by, now });
  writeBlocks(open(sub), [todo("A book worth reading"), todo("An article to come back to")]);
  return { first, pages: [first, tasks, ideas, sub] };
}
