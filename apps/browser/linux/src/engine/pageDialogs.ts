import { BrowserWindow, dialog, ipcMain } from "electron";
import { isBackground } from "../paths";
import { acceptsPage } from "../ipcSenders";
import { guestOf, windowOf } from "./guests";

const PROMPT_ANSWER = "ardia-prompt:";

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

const escaped = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function promptPage(title: string, message: string, fallback: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escaped(title)}</title><style>
body{margin:0;padding:18px;font:13px system-ui,sans-serif;background:#fff;color:#111}
@media (prefers-color-scheme:dark){body{background:#2a2a2a;color:#eee}input{background:#1e1e1e;color:#eee;border-color:#555}}
p{margin:0 0 10px;white-space:pre-wrap;max-height:120px;overflow:auto}input{width:100%;box-sizing:border-box;padding:6px;border:1px solid #bbb;border-radius:6px;font:inherit}
.row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}button{padding:5px 14px;border-radius:6px;border:1px solid #bbb;background:transparent;color:inherit;font:inherit}
button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}</style></head><body>
<p>${escaped(message)}</p><input id="answer" value="${escaped(fallback)}" autofocus>
<div class="row"><button id="cancel">Cancel</button><button id="ok" class="primary">OK</button></div>
<script>
const answer = document.getElementById("answer");
const done = (value) => { document.title = ${JSON.stringify(PROMPT_ANSWER)} + JSON.stringify(value); };
document.getElementById("ok").onclick = () => done(answer.value);
document.getElementById("cancel").onclick = () => done(null);
addEventListener("keydown", (e) => { if (e.key === "Enter") done(answer.value); if (e.key === "Escape") done(null); });
answer.select();
</script></body></html>`;
}

function askForText(parent: BrowserWindow | null, title: string, message: string, fallback: string): Promise<string | null> {
  return new Promise((resolve) => {
    const asking = new BrowserWindow({
      width: 420,
      height: 190,
      resizable: false,
      minimizable: false,
      maximizable: false,
      modal: !!parent,
      ...(parent ? { parent } : {}),
      autoHideMenuBar: true,
      title,
      webPreferences: { sandbox: true, contextIsolation: true, javascript: true },
    });
    let answered = false;
    const finish = (value: string | null) => {
      if (answered) return;
      answered = true;
      resolve(value);
      if (!asking.isDestroyed()) asking.close();
    };
    asking.webContents.on("page-title-updated", (_event, pageTitle) => {
      if (!pageTitle.startsWith(PROMPT_ANSWER)) return;
      try {
        const value = JSON.parse(pageTitle.slice(PROMPT_ANSWER.length)) as unknown;
        finish(typeof value === "string" ? value : null);
      } catch {
        finish(null);
      }
    });
    asking.once("closed", () => finish(null));
    void asking.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(promptPage(title, message, fallback))}`);
  });
}

async function answer(kind: string, url: string, parent: BrowserWindow | null, message: string, fallback: string | null): Promise<unknown> {
  const title = hostOf(url);
  if (isBackground()) {
    console.info(`[ardia linux] page ${kind} from ${title}: ${message.slice(0, 200)}`);
    return kind === "prompt" ? null : kind === "confirm" ? false : null;
  }
  if (kind === "prompt") return askForText(parent, title, message, fallback ?? "");
  const options = {
    type: kind === "confirm" ? ("question" as const) : ("info" as const),
    title,
    message: `${title} says`,
    detail: message,
    buttons: kind === "confirm" ? ["OK", "Cancel"] : ["OK"],
    defaultId: 0,
    cancelId: kind === "confirm" ? 1 : 0,
    noLink: true,
  };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return kind === "confirm" ? response === 0 : null;
}

ipcMain.on("ardia:page-dialog", (event, kind: unknown, message: unknown, fallback: unknown) => {
  if (!acceptsPage(event, "ardia:page-dialog")) {
    event.returnValue = null;
    return;
  }
  const guest = guestOf(event.sender);
  const parent = guest ? windowOf(guest) : null;
  void answer(String(kind), event.sender.getURL(), parent, String(message ?? ""), typeof fallback === "string" ? fallback : null)
    .catch(() => null)
    .then((value) => {
      event.returnValue = value ?? null;
    });
});
