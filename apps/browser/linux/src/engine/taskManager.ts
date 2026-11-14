import { app, BrowserWindow, nativeTheme, webContents as allContents } from "electron";
import { randomUUID } from "node:crypto";
import { count } from "../counts";
import { guestOf } from "./guests";
import { note } from "../log";
import { isBackground } from "../paths";

const REFRESH_MS = 1000;
const KIND_LABELS: Record<string, string> = { Browser: "Browser", GPU: "GPU Process", Utility: "Utility", Zygote: "Zygote", "Sandbox helper": "Sandbox Helper", Tab: "Renderer" };

type Row = { pid: number; task: string; memory: number; cpu: number; killable: boolean };

let open: BrowserWindow | null = null;

const RANKED = ["Browser", "Ardia", "Task Manager", "GPU Process"];

function rank(row: Row): number {
  const known = RANKED.findIndex((task) => row.task === task || row.task.startsWith(`${task}:`));
  if (known >= 0) return known;
  return row.killable ? RANKED.length + 1 : RANKED.length;
}

function rows(): Row[] {
  const pages = new Map<number, string[]>();
  const own = new Map<number, string>();
  for (const contents of allContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const guest = guestOf(contents);
    if (!guest) {
      const pid = contents.getOSProcessId();
      if (open && !open.isDestroyed() && contents === open.webContents) own.set(pid, "Task Manager");
      else if (!own.has(pid) && contents.getType() !== "backgroundPage") own.set(pid, "Ardia");
      continue;
    }
    const pid = contents.getOSProcessId();
    const title = contents.getTitle() || guest.url || "Untitled";
    pages.set(pid, [...(pages.get(pid) ?? []), title]);
  }
  return app
    .getAppMetrics()
    .map((metric) => {
      const titles = pages.get(metric.pid);
      const kind = KIND_LABELS[metric.type] ?? metric.type;
      const task = titles ? `Tab: ${titles.join(", ")}` : metric.serviceName ? `${kind}: ${metric.name || metric.serviceName}` : metric.type === "Tab" ? (own.get(metric.pid) ?? "Ardia") : kind;
      return { pid: metric.pid, task, memory: metric.memory.workingSetSize * 1024, cpu: metric.cpu.percentCPUUsage, killable: !!titles };
    })
    .sort((a, b) => rank(a) - rank(b) || a.pid - b.pid);
}

function endProcess(pid: number) {
  let ended = 0;
  for (const contents of allContents.getAllWebContents()) {
    if (contents.isDestroyed() || !guestOf(contents) || contents.getOSProcessId() !== pid) continue;
    contents.forcefullyCrashRenderer();
    ended++;
  }
  if (ended) count("task_manager_processes_ended");
  note("taskManager", `ended a page process holding ${ended} page${ended === 1 ? "" : "s"}`);
}

function page(token: string, dark: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Task Manager</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
:root{color-scheme:${dark ? "dark" : "light"};font:13px system-ui,sans-serif}
body{margin:0;display:flex;flex-direction:column;height:100vh;background:${dark ? "#202124" : "#fff"};color:${dark ? "#e8eaed" : "#202124"};user-select:none}
.list{flex:1;overflow:auto}
table{width:100%;border-collapse:collapse}
th{position:sticky;top:0;text-align:left;font-weight:600;padding:7px 10px;background:${dark ? "#2b2c2f" : "#f1f3f4"};border-bottom:1px solid ${dark ? "#3c4043" : "#dadce0"}}
td{padding:5px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0}
th.n,td.n{text-align:right;width:92px}
tr.row:hover{background:${dark ? "#2f3033" : "#f5f5f5"}}
tr.selected,tr.selected:hover{background:${dark ? "#394457" : "#e8f0fe"}}
footer{display:flex;justify-content:flex-end;padding:10px;border-top:1px solid ${dark ? "#3c4043" : "#dadce0"}}
button{font:inherit;padding:6px 16px;border-radius:7px;border:1px solid ${dark ? "#5f6368" : "#dadce0"};background:${dark ? "#303134" : "#fff"};color:inherit}
button:disabled{opacity:.45}
</style></head><body><div class="list"><table><thead><tr><th>Task</th><th class="n">Memory</th><th class="n">CPU</th><th class="n">Process ID</th></tr></thead><tbody id="rows"></tbody></table></div>
<footer><button id="end" disabled>End Process</button></footer>
<script>
let selected=null;let latest=[];
const end=document.getElementById("end");
const megabytes=(bytes)=>(bytes/1048576).toFixed(1)+" MB";
window.render=(list)=>{latest=list;const body=document.getElementById("rows");body.replaceChildren();
for(const row of list){const tr=document.createElement("tr");tr.className="row"+(row.pid===selected?" selected":"");
for(const [text,numeric] of [[row.task,false],[megabytes(row.memory),true],[row.cpu.toFixed(1),true],[String(row.pid),true]]){const td=document.createElement("td");td.textContent=text;td.title=text;if(numeric)td.className="n";tr.append(td);}
tr.onclick=()=>{selected=row.pid;render(latest);};body.append(tr);}
const chosen=list.find((row)=>row.pid===selected);end.disabled=!chosen||!chosen.killable;};
end.onclick=()=>{if(selected!==null)document.title=JSON.stringify({token:${JSON.stringify(token)},end:selected,at:Date.now()});};
</script></body></html>`;
}

export function openTaskManager(): boolean {
  if (open && !open.isDestroyed()) {
    open.show();
    open.focus();
    return true;
  }
  if (isBackground()) {
    note("taskManager", `not shown in a background instance: ${rows().length} processes`);
    return true;
  }
  count("task_manager_opens");
  const token = randomUUID();
  const dark = nativeTheme.shouldUseDarkColors;
  const window = new BrowserWindow({
    width: 620,
    height: 420,
    minWidth: 420,
    minHeight: 240,
    title: "Task Manager",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: dark ? "#202124" : "#ffffff",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
  });
  open = window;
  window.setMenu(null);
  const refresh = () => {
    if (!window.isDestroyed()) void window.webContents.executeJavaScript(`window.render && window.render(${JSON.stringify(rows())})`, false).catch(() => {});
  };
  const timer = setInterval(refresh, REFRESH_MS);
  window.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    try {
      const reply = JSON.parse(title) as { token?: string; end?: number };
      if (reply.token === token && typeof reply.end === "number") {
        endProcess(reply.end);
        refresh();
      }
    } catch {}
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.once("did-finish-load", refresh);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    clearInterval(timer);
    if (open === window) open = null;
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(token, dark))}`);
  return true;
}
