import { BrowserWindow, app, dialog, nativeTheme } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { defineModule } from "../bridge";
import { testFlag } from "../launch";
import { activation } from "../log";
import { dataDirectory, isBackground } from "../paths";
import { appWindow } from "../windows";

type ConfirmOptions = { title: string; message?: string; confirmTitle?: string; cancelTitle?: string; destructive?: boolean; suppression?: string; windowId?: string };
type PromptOptions = { title: string; message?: string; value?: string; placeholder?: string; confirmTitle?: string; windowId?: string };

let openCount = 0;

function owner(windowId?: string | null): BrowserWindow | undefined {
  const chosen = windowId ? appWindow(windowId) : undefined;
  if (chosen && !chosen.isDestroyed() && chosen.isVisible()) return chosen;
  return BrowserWindow.getFocusedWindow() ?? undefined;
}

async function counted<T>(run: () => Promise<T>): Promise<T> {
  openCount++;
  try {
    return await run();
  } finally {
    openCount--;
  }
}

function testAnswer(dumped: Record<string, unknown>): string | null {
  if (!testFlag("appDialog")) return null;
  const file = join(dataDirectory(), "dialog.json");
  writeFileSync(file, JSON.stringify(dumped, null, 2));
  try {
    const pick = readFileSync(`${file}.pick`, "utf8");
    rmSync(`${file}.pick`, { force: true });
    return pick.trim();
  } catch {
    return null;
  }
}

function answerInBackground(title: string, message: string, titles: string[]): number {
  const cancel = titles.indexOf("Cancel");
  const pick = cancel >= 0 ? cancel : Math.max(0, titles.length - 1);
  activation(`alert (not shown): app-modal | "${title}" | "${message}" | buttons ${titles.join(", ")} | chose ${titles[pick] ?? "OK"}`);
  return pick;
}

function takePicks(): string[] {
  const file = join(dataDirectory(), "file-chooser.txt");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  rmSync(file, { force: true });
  return text.split(/\r?\n/).filter(Boolean);
}

export const confirmWithUser = (options: ConfirmOptions) => confirm(options);

async function confirm(options: ConfirmOptions) {
  const message = options.message ?? "";
  const confirmTitle = options.confirmTitle ?? "OK";
  const cancelTitle = options.cancelTitle ?? "Cancel";
  const answer = testAnswer({ kind: "confirm", title: options.title, message, confirmTitle, cancelTitle, destructive: !!options.destructive, suppression: options.suppression, windowId: options.windowId });
  if (answer !== null) {
    const words = answer.split(",").map((word) => word.trim());
    return { confirmed: words.includes("confirm"), suppressed: words.includes("suppress") };
  }
  if (isBackground()) return { confirmed: answerInBackground(options.title, message, [confirmTitle, cancelTitle]) === 0, suppressed: false };
  return counted(async () => {
    const parent = owner(options.windowId);
    const settings: Electron.MessageBoxOptions = {
      type: options.destructive ? "warning" : cancelTitle ? "question" : "info",
      title: options.title,
      message: options.title,
      detail: message || undefined,
      buttons: cancelTitle ? [confirmTitle, cancelTitle] : [confirmTitle],
      defaultId: options.destructive && cancelTitle ? 1 : 0,
      cancelId: cancelTitle ? 1 : 0,
      noLink: true,
      checkboxLabel: options.suppression,
      checkboxChecked: false,
    };
    const reply = parent ? await dialog.showMessageBox(parent, settings) : await dialog.showMessageBox(settings);
    return { confirmed: reply.response === 0, suppressed: reply.response === 0 && !!options.suppression && reply.checkboxChecked };
  });
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function promptPage(token: string, options: PromptOptions, dark: boolean): string {
  const confirmTitle = escapeHtml(options.confirmTitle ?? "OK");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
:root{color-scheme:${dark ? "dark" : "light"};font:13px system-ui,sans-serif}
body{margin:0;padding:18px 20px 16px;background:${dark ? "#2b2b2e" : "#f6f6f7"};color:${dark ? "#f2f2f2" : "#1d1d1f"};user-select:none}
h1{font-size:14px;font-weight:600;margin:0 0 6px}p{margin:0 0 12px;opacity:.75;line-height:1.35}
input{box-sizing:border-box;width:100%;font:inherit;padding:7px 9px;border-radius:7px;border:1px solid ${dark ? "#4a4a50" : "#c9c9ce"};background:${dark ? "#1e1e20" : "#fff"};color:inherit;outline:none}
input:focus{border-color:#5b8def;box-shadow:0 0 0 3px #5b8def40}
.row{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
button{font:inherit;padding:6px 14px;border-radius:7px;border:1px solid ${dark ? "#4a4a50" : "#c9c9ce"};background:${dark ? "#3a3a3e" : "#fff"};color:inherit}
button.primary{background:#3b6fe0;border-color:#3b6fe0;color:#fff}
</style></head><body><h1>${escapeHtml(options.title)}</h1>${options.message ? `<p>${escapeHtml(options.message)}</p>` : ""}
<input id="field" value="${escapeHtml(options.value ?? "")}" placeholder="${escapeHtml(options.placeholder ?? "")}" autofocus>
<div class="row"><button id="cancel">Cancel</button><button id="ok" class="primary">${confirmTitle}</button></div>
<script>
const field=document.getElementById("field");field.select();
const send=(value)=>{document.title=JSON.stringify({token:${JSON.stringify(token)},value});};
document.getElementById("ok").onclick=()=>send(field.value);
document.getElementById("cancel").onclick=()=>send(null);
addEventListener("keydown",(e)=>{if(e.key==="Enter")send(field.value);if(e.key==="Escape")send(null);});
</script></body></html>`;
}

async function prompt(options: PromptOptions): Promise<string | null> {
  const message = options.message ?? "";
  const value = options.value ?? "";
  const confirmTitle = options.confirmTitle ?? "OK";
  const answer = testAnswer({ kind: "prompt", title: options.title, message, value, confirmTitle, placeholder: options.placeholder, windowId: options.windowId });
  if (answer !== null) return answer || null;
  if (isBackground()) {
    const text = value.trim();
    return answerInBackground(options.title, message, [confirmTitle, "Cancel"]) === 0 && text ? text : null;
  }
  return counted(
    () =>
      new Promise<string | null>((resolve) => {
        const parent = owner(options.windowId);
        const token = randomUUID();
        const window = new BrowserWindow({
          parent,
          modal: !!parent,
          width: 380,
          height: options.message ? 176 : 150,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          useContentSize: true,
          show: false,
          title: options.title,
          autoHideMenuBar: true,
          backgroundColor: nativeTheme.shouldUseDarkColors ? "#2b2b2e" : "#f6f6f7",
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
        });
        window.setMenu(null);
        let settled = false;
        const finish = (result: string | null) => {
          if (settled) return;
          settled = true;
          const text = result?.trim() ?? "";
          resolve(text || null);
          if (!window.isDestroyed()) window.close();
        };
        window.webContents.on("page-title-updated", (_event, title) => {
          try {
            const reply = JSON.parse(title) as { token?: string; value?: string | null };
            if (reply.token === token) finish(reply.value ?? null);
          } catch {}
        });
        window.webContents.on("will-navigate", (event) => event.preventDefault());
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.on("closed", () => finish(null));
        window.once("ready-to-show", () => window.show());
        void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(promptPage(token, options, nativeTheme.shouldUseDarkColors))}`);
      }),
  );
}

async function pickFiles(): Promise<string[]> {
  if (isBackground()) {
    const picks = takePicks();
    activation(`open panel (not shown): free-standing | multiple=1 files=1 directories=0 | types=* others=1 | ${picks.length ? `chose ${picks.join(", ")}` : "cancelled"}`);
    return picks.map((path) => pathToFileURL(path).href);
  }
  return counted(async () => {
    const parent = owner();
    const settings: Electron.OpenDialogOptions = { properties: ["openFile", "multiSelections"] };
    const reply = parent ? await dialog.showOpenDialog(parent, settings) : await dialog.showOpenDialog(settings);
    return reply.canceled ? [] : reply.filePaths.map((path) => pathToFileURL(path).href);
  });
}

async function pickFolder(current: string | null, promptText: string | null): Promise<string | null> {
  if (isBackground()) {
    const picks = takePicks();
    activation(`open panel (not shown): free-standing | multiple=0 files=0 directories=1 | types=* others=1${current ? ` | directory=${current}` : ""} | ${picks.length ? `chose ${picks.join(", ")}` : "cancelled"}`);
    return picks[0] ?? null;
  }
  return counted(async () => {
    const parent = owner();
    const settings: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"], defaultPath: current ?? undefined, buttonLabel: promptText ?? undefined };
    const reply = parent ? await dialog.showOpenDialog(parent, settings) : await dialog.showOpenDialog(settings);
    return reply.canceled ? null : (reply.filePaths[0] ?? null);
  });
}

async function saveFile(name: string, extension: string, kind: string, message: string): Promise<string | null> {
  if (isBackground()) {
    const picks = takePicks();
    activation(`save panel (not shown): name=${name} extension=${extension} kind=${kind} | ${picks.length ? "chose a file" : "cancelled"}`);
    return picks[0] ?? null;
  }
  return counted(async () => {
    const parent = owner();
    const settings: Electron.SaveDialogOptions = {
      defaultPath: join(app.getPath("downloads"), extension && !name.endsWith(`.${extension}`) ? `${name}.${extension}` : name),
      filters: extension ? [{ name: kind || extension.toUpperCase(), extensions: [extension] }] : undefined,
      message: message || undefined,
      properties: ["createDirectory", "showOverwriteConfirmation"],
    };
    const reply = parent ? await dialog.showSaveDialog(parent, settings) : await dialog.showSaveDialog(settings);
    return reply.canceled || !reply.filePath ? null : reply.filePath;
  });
}

defineModule("ArdiaDialogs", {
  sync: { openCount: () => openCount },
  async: {
    confirm,
    prompt,
    pickFiles,
    pickFolder,
    saveFile,
    devHoldConfirm: async () => false,
    devReleaseDialogs: async () => {},
  },
});
