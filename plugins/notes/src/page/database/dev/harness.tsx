import "../../styles/tokens.css";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { createMockClient, type MockSeedApi } from "../../client/mock";
import { pageDocId, treeDocId } from "../../../shared/protocol";
import { createPage, getPage } from "../../../shared/model";
import {
  addOption,
  addProperty,
  addRelationProperty,
  addView,
  createRow,
  initDatabase,
  initLinkedDatabase,
  readSchema,
  rememberPerson,
  setRelation,
  settingsOf,
  updateView,
  type Property,
} from "../../../shared/database";
import { DatabasePage, RowProperties } from "../index";
import { registerCss } from "../styles";

export const WS = "d0d0d0d0d0d0";
export const IDS = { tasks: "da7aba5e0001", projects: "da7aba5e0002", big: "da7aba5e0003", empty: "da7aba5e0004", host: "da7aba5e0005", inline: "da7aba5e0006", linked: "da7aba5e0007" };
const PEOPLE = [
  { id: "person-ada", name: "Ada Lovelace", color: "#C07A98" },
  { id: "person-grace", name: "Grace Hopper", color: "#4691C3" },
  { id: "person-alan", name: "Alan Kay", color: "#3EB489" },
];

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function seed(api: MockSeedApi) {
  const params = new URLSearchParams(location.search);
  api.addWorkspace({ id: WS, name: "Databases", icon: "🗃️", shared: false, folderId: null });
  const tree = api.doc(WS, treeDocId);
  const by = api.me.deviceId;
  createPage(tree, { id: IDS.tasks, parent: "", kind: "database", title: "Tasks", icon: "✅", by });
  createPage(tree, { id: IDS.projects, parent: "", kind: "database", title: "Projects", icon: "📁", by });
  createPage(tree, { id: IDS.big, parent: "", kind: "database", title: "Big table", icon: "📈", by });
  createPage(tree, { id: IDS.empty, parent: "", kind: "database", title: "", by, props: { initialView: "table" } });
  createPage(tree, { id: IDS.host, parent: "", kind: "page", title: "Host page", icon: "📄", by });
  createPage(tree, { id: IDS.inline, parent: IDS.host, kind: "database", title: "Reading list", by, props: { inline: true } });
  createPage(tree, { id: IDS.linked, parent: IDS.host, kind: "database", title: "", by, props: { inline: true } });
  if (params.has("bare")) return;

  const projects = api.doc(WS, pageDocId(IDS.projects));
  initDatabase(projects);
  const budget = addProperty(projects, { type: "number", name: "Budget", format: "dollar" });
  const pids = ["Website", "Mobile app", "Launch"].map((t, i) => createRow(tree, IDS.projects, readSchema(projects), { by, title: t, props: { [budget]: (i + 1) * 12500 } }));

  const tasks = api.doc(WS, pageDocId(IDS.tasks));
  for (const p of PEOPLE) rememberPerson(tasks, p);
  initDatabase(tasks);
  const status = addProperty(tasks, { type: "status", name: "Status" });
  const priority = addProperty(tasks, { type: "select", name: "Priority" });
  const [high, med, low] = ["High", "Medium", "Low"].map((n, i) => addOption(tasks, priority, n, { color: (["red", "yellow", "green"] as const)[i]! }));
  const tagIds = ["Design", "Eng", "Bug", "Docs"].map((n) => addOption(tasks, "tags", n));
  const due = addProperty(tasks, { type: "date", name: "Due" });
  const assignee = addProperty(tasks, { type: "person", name: "Assignee" });
  const estimate = addProperty(tasks, { type: "number", name: "Estimate" });
  const done = addProperty(tasks, { type: "checkbox", name: "Done" });
  const url = addProperty(tasks, { type: "url", name: "Link" });
  addProperty(tasks, { type: "email", name: "Email" });
  addProperty(tasks, { type: "phone", name: "Phone" });
  addProperty(tasks, { type: "files", name: "Files" });
  const score = addProperty(tasks, { type: "formula", name: "Score", expression: 'if(prop("Done"), 0, prop("Estimate") * 2)' });
  void score;
  const idProp = addProperty(tasks, { type: "id", name: "ID", prefix: "TASK" });
  const project = addRelationProperty(tasks, { name: "Project", target: IDS.projects, source: IDS.tasks, twoWay: true, targetDoc: projects, sourceName: "Tasks" });
  addProperty(tasks, { type: "created_time", name: "Created" });
  addProperty(tasks, { type: "edited_by", name: "Edited by" });
  const statusOpts = readSchema(tasks).find((p) => p.id === status)!.options;
  const titles = ["Design the landing page", "Fix login redirect", "Write onboarding docs", "Ship board drag", "Review calendar view", "Plan the launch", "Migrate database", "Polish dark mode"];
  const projectBack = readSchema(projects).find((p) => p.type === "relation")!;
  void projectBack;
  const rows = titles.map((title, i) =>
    createRow(tree, IDS.tasks, readSchema(tasks), {
      by,
      title,
      props: {
        [status]: statusOpts[i % 3]!.id,
        [priority]: [high, med, low][i % 3],
        tags: [tagIds[i % 4]!, ...(i % 3 === 0 ? [tagIds[(i + 1) % 4]!] : [])],
        [due]: i % 4 === 3 ? { start: day(i - 2), end: day(i + 1) } : { start: day(i * 2 - 5) },
        [assignee]: [PEOPLE[i % 3]!.id],
        [estimate]: (i + 1) * 3,
        [done]: i % 3 === 2,
        ...(i === 0 ? { [url]: "https://ardia.dev" } : {}),
      },
    }),
  );
  const schema = readSchema(tasks);
  const projProp = schema.find((p) => p.id === project)!;
  rows.forEach((r, i) => setRelation(tree, r, projProp, [pids[i % 3]!], by));
  void idProp;
  const back = readSchema(projects).find((p) => p.type === "relation")!;
  addProperty(projects, { type: "rollup", name: "Task count", rollupRelation: back.id, rollupTarget: "title", rollupFn: "count" });
  addProperty(projects, { type: "rollup", name: "Total estimate", rollupRelation: back.id, rollupTarget: estimate, rollupFn: "sum" });
  addView(tasks, "board", { id: "board", name: "Board" });
  addView(tasks, "calendar", { id: "calendar", name: "Calendar" });
  addView(tasks, "timeline", { id: "timeline", name: "Timeline" });
  addView(tasks, "list", { id: "list", name: "List" });
  addView(tasks, "gallery", { id: "gallery", name: "Gallery" });
  addView(tasks, "chart", { id: "chart", name: "Chart" });
  updateView(tasks, "default", { name: "All tasks" });

  const big = api.doc(WS, pageDocId(IDS.big));
  initDatabase(big);
  const n = addProperty(big, { type: "number", name: "Amount", format: "commas" });
  const sel = addProperty(big, { type: "select", name: "Kind" });
  const kinds = ["Alpha", "Beta", "Gamma", "Delta"].map((k) => addOption(big, sel, k));
  const when = addProperty(big, { type: "date", name: "When" });
  const count = Number(params.get("rows") ?? 2000);
  const bigSchema = readSchema(big);
  tree.transact(() => {
    for (let i = 0; i < count; i++) createRow(tree, IDS.big, bigSchema, { by, title: `Row ${i + 1}`, props: { [n]: (i * 37) % 1000, [sel]: kinds[i % 4], [when]: { start: day((i % 60) - 30) } } });
  });
  updateView(big, "default", { limit: 10000 });

  const inline = api.doc(WS, pageDocId(IDS.inline));
  initDatabase(inline);
  const author = addProperty(inline, { type: "text", name: "Author" });
  for (const [t, a] of [["Thinking, Fast and Slow", "Kahneman"], ["The Design of Everyday Things", "Norman"], ["Shape Up", "Singer"]]) createRow(tree, IDS.inline, readSchema(inline), { by, title: t, props: { [author]: a } });

  const linked = api.doc(WS, pageDocId(IDS.linked));
  initLinkedDatabase(linked, IDS.tasks, "board", readSchema(tasks));
  settingsOf(linked).set("initialized", true);
}

const client = createMockClient({ seed });
(window as unknown as Record<string, unknown>).notesClient = client;
(window as unknown as Record<string, unknown>).__db = { client, WS, IDS, Y, readSchema, pageDocId, treeDocId, getPage };

function useLocation() {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener("popstate", l);
      return () => window.removeEventListener("popstate", l);
    },
    () => location.search,
  );
}

function go(params: Record<string, string | null>) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) v === null ? q.delete(k) : q.set(k, v);
  q.delete("reset");
  history.pushState(null, "", `?${q}`);
  dispatchEvent(new PopStateEvent("popstate"));
}

function Harness() {
  const search = useLocation();
  const q = new URLSearchParams(search);
  const db = q.get("db") ?? IDS.tasks;
  const view = q.get("v");
  const peek = q.get("p");
  const theme = q.get("theme");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    client.ready.then(() => setReady(true));
  }, []);
  useEffect(() => {
    document.documentElement.style.colorScheme = theme === "dark" ? "dark" : theme === "light" ? "light" : "";
  }, [theme]);
  const [full, setFull] = useState<string | null>(null);
  if (!ready) return null;
  const onOpenRow = (row: string, mode: "peek" | "full") => (mode === "full" ? setFull(row) : go({ p: row }));
  const body = (row: { id: string }) => <div className="h-body" data-testid="h-body">Page body for {row.id}</div>;
  return (
    <div className="h-shell">
      <nav className="h-nav">
        {[
          ["Tasks", IDS.tasks],
          ["Projects", IDS.projects],
          ["Big table", IDS.big],
          ["Empty", IDS.empty],
          ["Host page", IDS.host],
        ].map(([label, id]) => (
          <button key={id} type="button" className={db === id ? "is-on" : ""} data-testid={`h-nav-${id}`} onClick={() => go({ db: id!, v: null, p: null })}>
            {label}
          </button>
        ))}
        <span className="h-flex" />
        <button type="button" data-testid="h-theme" onClick={() => go({ theme: theme === "dark" ? "light" : "dark" })}>
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </nav>
      <main className="h-main" data-testid="h-main">
        {full ? (
          <div className="h-fullpage" data-testid="h-fullpage">
            <button type="button" onClick={() => setFull(null)}>
              Back
            </button>
            <h1>{getPage(client.internals.docs.get(`${WS}|${treeDocId}`)!, full)?.title || "Untitled"}</h1>
            {(() => {
              const parent = getPage(client.internals.docs.get(`${WS}|${treeDocId}`)!, full)?.parent ?? "";
              return parent ? <RowProperties client={client} workspace={WS} database={parent} row={full} /> : null;
            })()}
          </div>
        ) : db === IDS.host ? (
          <div className="h-page">
            <h1>Host page</h1>
            <p>An inline database:</p>
            <DatabasePage client={client} workspace={WS} page={IDS.inline} view={q.get("v1")} inline onView={(v) => go({ v1: v })} onOpenRow={onOpenRow} renderBody={body} />
            <p>A linked view of Tasks:</p>
            <DatabasePage client={client} workspace={WS} page={IDS.linked} view={q.get("v2")} inline onView={(v) => go({ v2: v })} onOpenRow={onOpenRow} renderBody={body} />
          </div>
        ) : (
          <DatabasePage key={db} client={client} workspace={WS} page={db} view={view} inline={false} onView={(v) => go({ v })} onOpenRow={onOpenRow} peek={peek} onClosePeek={() => go({ p: null })} renderBody={body} />
        )}
      </main>
    </div>
  );
}

registerCss(
  "harness",
  `
html, body { margin: 0; background: var(--n-bg); color: var(--n-text); font-family: var(--n-font); }
.h-shell { min-height: 100vh; }
.h-nav { display: flex; gap: 4px; padding: 6px 12px; background: var(--n-bg); box-shadow: inset 0 -0.5px 0 var(--n-divider); }
.h-nav button { border: none; background: transparent; color: var(--n-text-2); font: inherit; font-size: 13px; padding: 4px 8px; border-radius: 6px; }
.h-nav button.is-on { background: var(--n-hover); color: var(--n-text); }
.h-flex { flex: 1; }
.h-page { max-width: 900px; margin: 0 auto; padding: 40px 24px; }
.h-page h1 { font-size: 36px; }
.h-fullpage { max-width: 760px; margin: 0 auto; padding: 40px 24px; }
.h-body { color: var(--n-text-3); font-size: 14px; }
`,
);

void ({} as Property);
createRoot(document.getElementById("root")!).render(<Harness />);
