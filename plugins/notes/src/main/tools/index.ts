import { IMPORT_SOURCE_IDS } from "../../shared/importSources";
import type { NotesAccess } from "./access";
import { ALIGNMENTS, BLOCKS, CELL_PROP_DEFS, COLOR_NAMES, LIMITS, STYLE_KEYS } from "./blocks";
import { Session } from "./common";
import { CONTENT_ACTIONS, PATCH_OPS, contentTool } from "./content";
import { PROPERTY_FIELDS, SCHEMA_INFO, VIEW_FIELDS, databaseTools } from "./database";
import { MARKDOWN_GUIDE } from "./markdown";
import { pageTools } from "./pages";
import { ToolError, any, arr, bool, checkFields, fieldsJson, int, oneOf, opt, quoteList, req, str, suggest, type Field } from "./spec";

type Action = { doc: string; fields: Record<string, Field>; run: (args: Record<string, unknown>) => Promise<unknown> };
type Tool = { title: string; doc: string; actions: Record<string, Action>; single?: string };

const ws = opt(str(64), "workspace id or name (default: the first workspace, or the page's own)");
const page = req(str(4096), "page id, ardia://notes/… address or exact title");
const db = req(str(4096), "database id or exact title");
const prop = req(str(200), "property name or id");
const pageFields = {
  title: opt(str(2000)),
  icon: opt(str(80), "one emoji, file:<sha256>, or \"\""),
  cover: opt(str(80), "\"\", gradient:0-11, color:0-9 or file:<sha256>"),
  coverY: opt(int(0, 100), "cover focus, percent from the top"),
  font: opt(oneOf(["default", "serif", "mono"])),
  fullWidth: opt(bool),
  smallText: opt(bool),
  locked: opt(bool, "locked pages refuse edits from the page and from content tools unless force"),
  isTemplate: opt(bool),
};
const body = {
  markdown: opt(str(900_000), "Markdown (describe › markdown)"),
  blocks: opt(any("BlockNote-style blocks (describe › blocks)", 900_000)),
};

export const TOOL_NAMES = ["describe", "workspaces", "me", "settings", "pages", "content", "database", "properties", "views", "rows", "comments", "history", "templates", "trash", "search", "files", "export", "import"] as const;

export type Counts = { since: number; calls: Record<string, number>; failures: Record<string, number> };

export function buildTools(a: NotesAccess): Record<string, Tool> {
  const s = new Session(a);
  const p = pageTools(s);
  const c = contentTool(s);
  const d = databaseTools(s);
  const has = (op: string) => a.has(op);
  const tools: Record<string, Tool> = {
    workspaces: {
      title: "Workspaces",
      doc: "The workspaces on this Mac: private ones and folders shared through iCloud Drive.",
      actions: {
        list: { doc: "Every workspace with its state.", fields: {}, run: async () => ({ workspaces: a.workspaces() }) },
        create: { doc: "A new private workspace.", fields: { name: req(str(200)) }, run: async (x) => ({ workspace: await a.run("createWorkspace", { name: x.name }) }) },
        create_shared: { doc: "A new workspace in iCloud Drive › Ardia Shared. Ardia asks the user to confirm.", fields: { name: req(str(200)) }, run: async (x) => ({ workspace: await a.run("createSharedWorkspace", { name: x.name }) }) },
        rename: {
          doc: "Rename a workspace or change its icon.",
          fields: { workspace: req(str(64)), name: opt(str(200)), icon: opt(str(80)) },
          run: async (x) => {
            const id = await s.workspace(x.workspace);
            if (x.name === undefined && x.icon === undefined) throw new ToolError("workspaces rename needs name or icon.");
            await a.run("renameWorkspace", { workspace: id, name: x.name ?? s.wsName(id), ...(x.icon !== undefined ? { icon: x.icon } : {}) });
            return { workspace: a.workspaces().find((w) => w.id === id) };
          },
        },
        share: { doc: "Share a private workspace: it moves into iCloud Drive and macOS's share sheet opens for the user.", fields: { workspace: req(str(64)) }, run: async (x) => a.run("shareWorkspace", { workspace: await s.workspace(x.workspace) }) },
        leave: {
          doc: "Remove a workspace from this Mac (a private one is deleted with its pages; a shared one stays in its folder).",
          fields: { workspace: req(str(64)), confirm: req(bool, "true: this removes it") },
          run: async (x) => {
            if (x.confirm !== true) throw new ToolError("workspaces leave removes the workspace from this Mac; pass confirm: true.");
            const id = await s.workspace(x.workspace);
            await a.run("leaveWorkspace", { workspace: id });
            return { left: id, workspaces: a.workspaces() };
          },
        },
      },
    },
    me: {
      title: "Me",
      doc: "The name and colour others see on your edits, cursors and comments.",
      actions: {
        get: { doc: "Your name, colour and device id.", fields: {}, run: async () => ({ me: a.me() }) },
        set: {
          doc: "Change your name or colour.",
          fields: { name: opt(str(80)), color: opt(str(7, { pattern: /^#[0-9a-fA-F]{6}$/, what: "a #rrggbb colour" })) },
          run: async (x) => ({ me: await a.run("setMe", { ...(x.name !== undefined ? { name: x.name } : {}), ...(x.color !== undefined ? { color: x.color } : {}) }) }),
        },
      },
    },
    settings: {
      title: "Settings",
      doc: "The plugin's settings rows (Settings › Plugins › Notes). Read only here: Ardia keeps row values, and Your Name follows me set.",
      actions: {
        get: { doc: "Row values.", fields: {}, run: async () => ({ settings: { name: a.setting("name") ?? "", searchEverywhere: a.setting("searchEverywhere") !== false }, me: a.me() }) },
      },
    },
    pages: {
      title: "Pages",
      doc: "Pages and databases as items in the tree: find, create, change, move, trash and open them.",
      actions: {
        list: {
          doc: "Pages, newest edit first, paginated.",
          fields: { workspace: ws, parent: opt(str(4096), "only children of this page"), kind: opt(oneOf(["page", "database"])), archived: opt(bool, "include the trash"), templates: opt(bool, "true: only templates; false: no templates"), rows: opt(bool, "false: leave out database rows"), limit: opt(int(1, 500)), cursor: opt(str(20)) },
          run: p.pages.list,
        },
        tree: { doc: "The page tree, nested.", fields: { workspace: ws, root: opt(str(4096)), depth: opt(int(1, 50)), limit: opt(int(1, 10_000)), archived: opt(bool) }, run: p.pages.tree },
        get: { doc: "One page's details, with its body as Markdown (or blocks).", fields: { page, workspace: ws, content: opt(oneOf(["markdown", "blocks", "none"])), ids: opt(bool, "markdown with {#blockId}") }, run: p.pages.get },
        create: {
          doc: "A new page (or database with kind: database). Markdown starting with '# Title' sets the title. Under a page, a page block is added there too (addBlock: false to skip).",
          fields: { workspace: ws, parent: opt(str(4096)), kind: opt(oneOf(["page", "database"])), after: opt(str(4096), "sibling to go after"), template: opt(str(4096), "template page to copy"), addBlock: opt(bool), ...pageFields, ...body },
          run: p.pages.create,
        },
        update: { doc: "Change a page's title, icon, cover, font, width, text size, lock or template flag.", fields: { page, workspace: ws, ...pageFields }, run: p.pages.update },
        move: { doc: "Move under another page (or \"\" for the top), after a sibling, or to another workspace.", fields: { page, workspace: ws, parent: req(str(4096)), after: opt({ t: "oneOf", of: [str(4096), { t: "null" }] }, "sibling to go after; null for first"), toWorkspace: opt(str(64)) }, run: p.pages.move },
        duplicate: { doc: "Copy a page with everything under it.", fields: { page, workspace: ws }, run: p.pages.duplicate },
        archive: { doc: "Move to the trash (recoverable).", fields: { page, workspace: ws }, run: p.pages.archive },
        restore: { doc: "Bring back from the trash.", fields: { page, workspace: ws }, run: p.pages.restore },
        delete: { doc: "Delete for good. The page must be in the trash, or pass permanent: true.", fields: { page, workspace: ws, permanent: opt(bool) }, run: p.pages.delete },
        open: { doc: "Open the page in an Ardia tab.", fields: { page, workspace: ws, view: opt(str(64), "database view id"), peek: opt(str(12), "row id to open as a peek") }, run: p.pages.open },
        backlinks: { doc: "Pages that mention or link to this one.", fields: { page, workspace: ws }, run: p.pages.backlinks },
        resolve: { doc: "Turn an ardia://notes/… address into its page.", fields: { address: req(str(4096)) }, run: p.pages.resolve },
      },
    },
    content: {
      title: "Page content",
      doc: "A page's body: read as Markdown or blocks with ids, write whole, append, or patch block by block. Edits go through Yjs, so open pages and collaborators see them live and keep their own edits.",
      actions: Object.fromEntries(Object.entries(CONTENT_ACTIONS).map(([k, v]) => [k, { ...v, run: (c as Record<string, (x: Record<string, unknown>) => Promise<unknown>>)[k]! }])),
    },
    database: {
      title: "Databases",
      doc: "Databases: their schema, views, settings; make new ones (full page or inline) and linked views.",
      actions: {
        list: { doc: "Every database in a workspace.", fields: { workspace: ws }, run: d.database.list },
        get: { doc: "A database's properties, views, settings, templates and row count.", fields: { database: db }, run: d.database.get },
        create: {
          doc: "A new database. inline: true puts it inside parent as a block.",
          fields: { workspace: ws, parent: opt(str(4096)), title: opt(str(2000)), icon: opt(str(80)), view: opt(oneOf(SCHEMA_INFO.viewTypes)), inline: opt(bool), description: opt(str(4000)), properties: opt(arr(any("property: {name, type, …config} as properties add"), 100)) },
          run: d.database.create,
        },
        link: { doc: "A linked view of an existing database, as an inline block in parent.", fields: { source: db, parent: page, view: opt(oneOf(SCHEMA_INFO.viewTypes)) }, run: d.database.link },
        update: {
          doc: "Title, icon, description, how rows open, lock and default template.",
          fields: { database: db, title: opt(str(2000)), icon: opt(str(80)), description: opt(str(4000)), showDescription: opt(bool), openAs: opt(oneOf(["side", "center", "full"])), locked: opt(bool), defaultTemplate: opt({ t: "oneOf", of: [str(4096), { t: "null" }] }, "template id or title; \"\" or null for none") },
          run: d.database.update,
        },
      },
    },
    properties: {
      title: "Database properties",
      doc: "A database's columns: all property types with their settings, select options and colours.",
      actions: {
        list: { doc: "The properties.", fields: { database: db }, run: d.properties.list },
        add: { doc: "Add a property.", fields: { database: db, name: opt(str(200)), type: req(oneOf(SCHEMA_INFO.propertyTypes.map((t) => t.type))), after: opt({ t: "oneOf", of: [str(200), { t: "null" }] }), ...withoutKeys(PROPERTY_FIELDS, ["name", "type"]) }, run: d.properties.add },
        update: { doc: "Rename, retype (values convert as in the app) or reconfigure. options replaces the whole list in order, keeping options with the same name.", fields: { database: db, property: prop, ...PROPERTY_FIELDS }, run: d.properties.update },
        delete: { doc: "Delete a property.", fields: { database: db, property: prop }, run: d.properties.delete },
        move: { doc: "Put a property after another (null for first).", fields: { database: db, property: prop, after: opt({ t: "oneOf", of: [str(200), { t: "null" }] }) }, run: d.properties.move },
        duplicate: { doc: "Copy a property (without values).", fields: { database: db, property: prop }, run: d.properties.duplicate },
        option_add: { doc: "Add a select, multi-select or status option.", fields: { database: db, property: prop, name: req(str(200)), color: opt(oneOf(COLOR_NAMES)), group: opt(oneOf(["todo", "doing", "done"])) }, run: d.properties.option_add },
        option_update: { doc: "Rename or recolour an option, or move a status option to another group.", fields: { database: db, property: prop, option: req(str(200)), name: opt(str(200)), color: opt(oneOf(COLOR_NAMES)), group: opt(oneOf(["todo", "doing", "done"])) }, run: d.properties.option_update },
        option_delete: { doc: "Delete an option.", fields: { database: db, property: prop, option: req(str(200)) }, run: d.properties.option_delete },
        option_move: { doc: "Reorder an option.", fields: { database: db, property: prop, option: req(str(200)), after: opt({ t: "oneOf", of: [str(200), { t: "null" }] }), group: opt(oneOf(["todo", "doing", "done"])) }, run: d.properties.option_move },
      },
    },
    views: {
      title: "Database views",
      doc: "Table, board, list, gallery, calendar, timeline and chart views with filters, sorts, grouping, visible properties, widths and layout settings.",
      actions: {
        list: { doc: "The views.", fields: { database: db }, run: d.views.list },
        get: { doc: "One view.", fields: { database: db, view: req(str(200), "view id or name") }, run: d.views.get },
        add: { doc: "Add a view.", fields: { database: db, after: opt(str(200)), ...VIEW_FIELDS }, run: d.views.add },
        update: { doc: "Change a view. filter and sorts replace the old ones; properties, calculations and groups change only what they name.", fields: { database: db, view: req(str(200)), ...VIEW_FIELDS }, run: d.views.update },
        delete: { doc: "Delete a view (the last one stays).", fields: { database: db, view: req(str(200)) }, run: d.views.delete },
        move: { doc: "Put a view after another (null for first).", fields: { database: db, view: req(str(200)), after: opt({ t: "oneOf", of: [str(200), { t: "null" }] }) }, run: d.views.move },
        duplicate: { doc: "Copy a view.", fields: { database: db, view: req(str(200)) }, run: d.views.duplicate },
      },
    },
    rows: {
      title: "Database rows",
      doc: "Rows are pages inside a database: query with filters and sorts, create, update and delete in bulk. A row's body is page content (content tool).",
      actions: {
        query: {
          doc: "Rows, filtered and sorted like a view (or by a view), paginated.",
          fields: { database: db, view: opt(str(200), "use this view's filter and sorts"), filter: opt(VIEW_FIELDS.filter!.spec), sorts: opt(arr(any("{prop, dir}"), 20)), search: opt(str(500)), limit: opt(int(1, 500)), cursor: opt(str(20)), properties: opt(arr(str(200), 200), "only these properties"), keys: opt(oneOf(["names", "ids"]), "key properties by name (default) or id"), content: opt(bool, "include each row's body as Markdown") },
          run: d.rows.query,
        },
        get: { doc: "One row with its properties and body.", fields: { row: req(str(4096)), keys: opt(oneOf(["names", "ids"])), content: opt(bool) }, run: d.rows.get },
        create: {
          doc: "Add rows. properties: {Name: value}; select and multi-select options that don't exist yet are made (createOptions: false to refuse).",
          fields: { database: db, rows: req(arr(any("{title?, icon?, properties?, markdown?, blocks?, template?}"), 200, 1)), after: opt({ t: "oneOf", of: [str(12), { t: "null" }] }), createOptions: opt(bool) },
          run: d.rows.create,
        },
        update: { doc: "Change rows' titles, icons and properties.", fields: { database: opt(str(4096)), rows: req(arr(any("{id, title?, icon?, properties?}"), 500, 1)), createOptions: opt(bool) }, run: d.rows.update },
        delete: { doc: "Move rows to the trash.", fields: { database: opt(str(4096)), rows: req(arr(str(12), 500, 1)) }, run: d.rows.delete },
        restore: { doc: "Bring rows back from the trash.", fields: { database: opt(str(4096)), rows: req(arr(str(12), 500, 1)) }, run: d.rows.restore },
        duplicate: { doc: "Copy rows with their bodies.", fields: { database: opt(str(4096)), rows: req(arr(str(12), 100, 1)) }, run: d.rows.duplicate },
        move: { doc: "Put a row after another in the manual order (null for first).", fields: { database: opt(str(4096)), row: req(str(12)), after: opt({ t: "oneOf", of: [str(12), { t: "null" }] }) }, run: d.rows.move },
      },
    },
    comments: {
      title: "Comments",
      doc: "Comment threads on a page or on a block's text.",
      actions: {
        list: { doc: "Threads (open by default).", fields: { page, workspace: ws, resolved: opt({ t: "oneOf", of: [bool, oneOf(["all"])] }, "true, false (default) or \"all\"") }, run: p.comments.list },
        add: { doc: "Start a thread on the page, or on a block (the whole text, or the first match of quote).", fields: { page, workspace: ws, text: req(str(20_000, { min: 1 })), block: opt(str(64)), quote: opt(str(2000)) }, run: p.comments.add },
        reply: { doc: "Reply in a thread.", fields: { page, workspace: ws, thread: req(str(64)), text: req(str(20_000, { min: 1 })) }, run: p.comments.reply },
        edit: { doc: "Edit one of your comments.", fields: { page, workspace: ws, thread: req(str(64)), comment: req(str(64)), text: req(str(20_000, { min: 1 })) }, run: p.comments.edit },
        resolve: { doc: "Resolve a thread.", fields: { page, workspace: ws, thread: req(str(64)) }, run: p.comments.resolve },
        unresolve: { doc: "Re-open a thread.", fields: { page, workspace: ws, thread: req(str(64)) }, run: p.comments.unresolve },
        delete: { doc: "Delete a thread, or one comment in it.", fields: { page, workspace: ws, thread: req(str(64)), comment: opt(str(64)) }, run: p.comments.delete },
      },
    },
    history: {
      title: "Version history",
      doc: "Snapshots Notes keeps of a page before edits (every 10 minutes of editing, 30 days).",
      actions: {
        list: { doc: "Versions, newest first.", fields: { page, workspace: ws }, run: p.history.list },
        get: { doc: "One version's body.", fields: { page, workspace: ws, version: req(str(120)), format: opt(oneOf(["markdown", "blocks"])) }, run: p.history.get },
        restore: { doc: "Put a version back (the current body is saved as a version first).", fields: { page, workspace: ws, version: req(str(120)) }, run: p.history.restore },
      },
    },
    templates: {
      title: "Templates",
      doc: "Page templates (any page marked as one) and database row templates.",
      actions: {
        list: { doc: "Page templates, or a database's row templates.", fields: { workspace: ws, database: opt(str(4096)) }, run: p.templates.list },
        create: { doc: "A new template: blank or from content, a copy of a page (from), or a row template in a database.", fields: { workspace: ws, database: opt(str(4096)), from: opt(str(4096)), title: opt(str(2000)), icon: opt(str(80)), default: opt(bool, "database: use it for new rows"), parent: opt(str(4096)), ...body }, run: p.templates.create },
        apply: { doc: "A new page from a template (under parent), a new row for a row template, or the template's blocks appended to target.", fields: { template: req(str(4096)), workspace: ws, parent: opt(str(4096)), target: opt(str(4096)), title: opt(str(2000)) }, run: p.templates.apply },
      },
    },
    trash: {
      title: "Trash",
      doc: "Pages moved to the trash; they come back with restore until deleted.",
      actions: {
        list: { doc: "What's in the trash.", fields: { workspace: ws }, run: p.trash.list },
        restore: { doc: "Bring a page back.", fields: { page, workspace: ws }, run: p.trash.restore },
        delete: { doc: "Delete a trashed page for good.", fields: { page, workspace: ws, permanent: opt(bool) }, run: p.trash.delete },
        empty: { doc: "Delete everything in the trash for good.", fields: { workspace: ws, confirm: req(bool) }, run: p.trash.empty },
      },
    },
    search: {
      title: "Search",
      doc: "Full-text search over titles, bodies and row properties: the index the command bar uses. An empty query lists recent pages.",
      single: "query",
      actions: { query: { doc: "Search.", fields: { query: req(str(500)), workspace: ws, limit: opt(int(1, 200)), titlesOnly: opt(bool) }, run: p.search } },
    },
    files: {
      title: "Files",
      doc: "Images and attachments, stored by their SHA-256 in the workspace.",
      actions: {
        upload: { doc: "Store a file (base64, up to about 700 KB per call) and get its file:<sha256> ref.", fields: { workspace: ws, page: opt(str(4096), "upload into this page's workspace"), name: req(str(255, { min: 1 })), type: opt(str(200), "MIME type"), data: req(str(950_000)) }, run: p.files.upload },
        get: { doc: "A file's bytes as base64.", fields: { workspace: ws, ref: req(str(80, { pattern: /^(file:)?[0-9a-f]{64}$/, what: "file:<sha256>" })) }, run: p.files.get },
        list: { doc: "Files a page uses.", fields: { page, workspace: ws }, run: p.files.list },
      },
    },
    export: {
      title: "Export",
      doc: "A page, or a page and everything under it, as Markdown or HTML text.",
      single: "page",
      actions: { page: { doc: "Export.", fields: { page, workspace: ws, format: opt(oneOf(["markdown", "html"])), subtree: opt(bool) }, run: p.export } },
    },
    import: {
      title: "Import",
      doc: "Bring notes in: Markdown text straight into a page, or an export from another app through Ardia's file picker.",
      actions: {
        markdown: {
          doc: "Make a page from Markdown or HTML-free text (a '# Title' first line names it).",
          fields: { workspace: ws, parent: opt(str(4096)), title: opt(str(2000)), markdown: req(str(900_000)) },
          run: (x) => p.pages.create({ ...x }),
        },
        upload: {
          doc: "Hand over an export file without a picker: send it as base64 parts in order (i from 0, up to 1,000,000 characters each) under one uploadId you make up (8 to 64 letters, digits, - or _), then import start {source, uploadId}.",
          fields: { uploadId: req(str(64)), i: req(int(0, 100_000)), name: req(str(200)), data: req(str(1_000_000)) },
          run: async (x) => {
            if (!has("importUpload")) throw new ToolError("This build of Notes can't take an uploaded export yet.");
            return a.run("importUpload", { uploadId: x.uploadId, i: x.i, name: x.name, data: x.data });
          },
        },
        start: {
          doc: "Import an export from another app. With uploadId it imports the file sent with import upload; otherwise Ardia shows its file or folder picker and the user chooses. Then poll status.",
          fields: { workspace: ws, source: req(oneOf(IMPORT_SOURCE_IDS)), pick: opt(oneOf(["file", "folder"])), uploadId: opt(str(64)) },
          run: async (x) => {
            if (!has("importStart")) throw new ToolError("This build of Notes can't import from other apps yet.");
            const job = await a.run("importStart", { workspace: await s.workspace(x.workspace), source: x.source, ...(x.uploadId ? { uploadId: x.uploadId } : { pick: x.pick ?? "folder" }) });
            return job ? { ...(job as object), hint: "import status {job} until state is done" } : { cancelled: true };
          },
        },
        status: { doc: "How an import is going (the latest when job is left out).", fields: { job: opt(str(12)) }, run: async (x) => ({ job: has("importStatus") ? await a.run("importStatus", x.job ? { job: x.job } : {}) : null }) },
        cancel: { doc: "Stop an import.", fields: { job: req(str(12)) }, run: async (x) => (has("importCancel") ? a.run("importCancel", { job: x.job }) : null) },
      },
    },
  };
  tools.describe = {
    title: "Describe",
    doc: "Everything these tools take, as data: tools, actions, fields, block types, Markdown dialect, property and view settings, filters, formulas.",
    single: "all",
    actions: { all: { doc: "Describe.", fields: { topic: opt(str(40), "one tool name, or blocks, markdown, database, patchOps; default everything") }, run: async (x) => describe(tools, x.topic as string | undefined, await a.storage.get<Counts>("toolCounts")) } },
  };
  return tools;
}

function withoutKeys(fields: Record<string, Field>, keys: string[]) {
  return Object.fromEntries(Object.entries(fields).filter(([k]) => !keys.includes(k)));
}

function describe(tools: Record<string, Tool>, topic: string | undefined, counts: Counts | undefined) {
  const toolsJson = Object.fromEntries(
    TOOL_NAMES.map((name) => {
      const t = tools[name]!;
      return [
        name,
        {
          title: t.title,
          description: t.doc,
          ...(t.single ? { action: "optional; the tool does one thing" } : {}),
          actions: Object.fromEntries(Object.entries(t.actions).map(([k, v]) => [k, { description: v.doc, input: fieldsJson(v.fields) }])),
        },
      ];
    }),
  );
  const blocks = {
    shape: "{id, type, props, content, children}: content is inline content (a list of text, link, mention, inlineEquation), plain text, or tableContent; ids are kept across edits",
    types: Object.fromEntries(Object.entries(BLOCKS).map(([type, def]) => [type, { description: def.doc, content: def.content, props: Object.fromEntries(Object.entries(def.props).map(([k, p]) => [k, { type: p.type, default: p.default ?? null, ...(p.values ? { values: p.values } : {}), description: p.doc }])) }])),
    inline: {
      text: '{type: "text", text, styles: {bold, italic, underline, strike, code: true; textColor, backgroundColor: colour}}',
      link: '{type: "link", href, content: [text…]}',
      mention: '{type: "mention", props: {kind: "page", pageId} | {kind: "user", name, color?} | {kind: "date", date: "YYYY-MM-DD"}}',
      inlineEquation: '{type: "inlineEquation", content: "TeX"}',
      shorthand: "a plain string is unstyled text; \\n is a line break",
    },
    styles: STYLE_KEYS,
    colors: COLOR_NAMES,
    alignments: ALIGNMENTS,
    table: { shape: '{type: "tableContent", headerRows, headerCols, columnWidths, rows: [{cells: [inline content or {type: "tableCell", props, content}]}]}', cellProps: Object.keys(CELL_PROP_DEFS) },
    limits: LIMITS,
  };
  const patchOps = Object.fromEntries(Object.entries(PATCH_OPS).map(([k, v]) => [k, { description: v.doc, input: fieldsJson(v.fields) }]));
  const database = {
    ...SCHEMA_INFO,
    values: {
      title: "text",
      "text, url, email, phone": "text (url needs its scheme)",
      number: "number",
      checkbox: "true or false",
      "select, status": "option name (or id)",
      multi_select: "list of option names",
      date: '"YYYY-MM-DD", "YYYY-MM-DDTHH:MM", or {start, end}',
      person: 'list of names or ids of people who used the database, or "me"',
      relation: "list of row ids or exact titles in the related database",
      files: "list of {ref: file:<sha256> from files upload or https://…, name, type}",
      "formula, rollup, created_time, created_by, edited_time, edited_by, id": "computed: read only",
      clear: "null clears a value",
    },
    filter: { shape: '{op: "and"|"or", rules: [{prop, cond, value} or a nested {op, rules}]} up to 3 deep', dateValues: '"YYYY-MM-DD" or {relative: "this_week"…}; between takes {start, end}' },
    sorts: '[{prop, dir: "asc"|"desc"}]',
    groupBy: "{prop, date: relative|day|week|month|year, text: exact|alpha, status: option|group, step, sort: manual|asc|desc, hideEmpty}",
    formula: { syntax: 'prop("Name") reads a property; operators + - * / % ^ == != > < >= <= && || ! ?:; lists [a, b]; method calls x.fn(); let(name, value, expr); current and index inside map/filter', functions: SCHEMA_INFO.formulaFunctions },
    propertyConfig: fieldsJson(PROPERTY_FIELDS),
    viewSettings: fieldsJson(VIEW_FIELDS),
  };
  const usage = { call: "ardia plugins call notes <tool> '<json>' with {action, …fields}; other plugins use tools.call", errors: "failures come back as the tool's error with the field that's wrong and what it takes", counts: counts ?? null };
  const all: Record<string, unknown> = { plugin: "notes", tools: toolsJson, blocks, patchOps, markdown: MARKDOWN_GUIDE, database, usage };
  if (!topic || topic === "all") return all;
  if (topic in all) return { [topic]: all[topic] };
  if (topic in toolsJson) return { tool: topic, ...(toolsJson[topic] as object) };
  throw new ToolError(`describe has no topic '${topic.slice(0, 40)}'${suggest(topic, [...Object.keys(all), ...TOOL_NAMES])} Topics: ${quoteList([...TOOL_NAMES, "blocks", "markdown", "database", "patchOps"])}.`);
}

export function makeHandlers(getAccess: () => NotesAccess | null, options: { count?: boolean } = {}): Record<string, (input: unknown) => Promise<unknown>> {
  let tools: Record<string, Tool> | null = null;
  let counts: Counts | null = null;
  let saving = false;
  let dirty = false;
  const note = (access: NotesAccess, key: string, failed: boolean) => {
    if (options.count === false) return;
    void (async () => {
      if (!counts) {
        const stored = await access.storage.get<Counts>("toolCounts").catch(() => undefined);
        counts = stored && typeof stored === "object" && stored.calls ? stored : { since: access.now(), calls: {}, failures: {} };
      }
      counts.calls[key] = (counts.calls[key] ?? 0) + 1;
      if (failed) counts.failures[key] = (counts.failures[key] ?? 0) + 1;
      dirty = true;
      if (saving) return;
      saving = true;
      while (dirty) {
        dirty = false;
        await access.storage.set("toolCounts", counts).catch(() => undefined);
      }
      saving = false;
    })();
  };
  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {};
  for (const name of TOOL_NAMES) {
    handlers[name] = async (input: unknown) => {
      const access = getAccess();
      if (!access) throw new Error("Notes is still starting; try again in a moment.");
      tools ??= buildTools(access);
      const tool = tools[name]!;
      const given = input === undefined || input === null ? {} : input;
      if (typeof given !== "object" || Array.isArray(given)) throw new Error(`${name} takes a JSON object like {"action": "${Object.keys(tool.actions)[0]}"}.`);
      const raw = given as Record<string, unknown>;
      const actions = Object.keys(tool.actions);
      const actionName = raw.action === undefined && tool.single ? tool.single : raw.action;
      let key = `${name}.?`;
      try {
        if (typeof actionName !== "string" || !tool.actions[actionName]) {
          const what = typeof actionName === "string" ? `'${actionName.slice(0, 40)}' isn't an action of ${name}${suggest(actionName, actions)}` : `${name} needs an action`;
          throw new ToolError(`${what} Actions: ${quoteList(actions)}. describe {topic: "${name}"} lists their fields.`);
        }
        key = `${name}.${actionName}`;
        const action = tool.actions[actionName]!;
        const { action: _drop, ...rest } = raw;
        const args = checkFields(action.fields, rest, `${name} ${actionName}`);
        const result = await action.run(args);
        note(access, key, false);
        return result ?? null;
      } catch (error) {
        note(access, key, true);
        if (error instanceof ToolError) throw new Error(error.message);
        throw error instanceof Error ? error : new Error(String(error));
      }
    };
  }
  return handlers;
}
