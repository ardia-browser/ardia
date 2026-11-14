import { BrowserWindow, nativeTheme } from "electron";
import type { OwnerPrompt, OwnerPromptUI } from "./ownerCheck";

const WIDTH = 440;
const HEIGHT = 196;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type PageText = { heading: string; detail: string; form: string; script: string };

const passwordPage = (reason: string): PageText => ({
  heading: `Ardia wants to ${escapeHtml(reason)}.`,
  detail: "Enter your login password to allow this.",
  form: `<form id="form"><input id="password" type="password" autocomplete="current-password" aria-label="Login password" autofocus>
<div class="error" id="error"></div>
<div class="buttons"><button type="button" id="cancel">Cancel</button><button type="submit" class="primary" id="ok">OK</button></div></form>`,
  script: `const form=document.getElementById("form"),field=document.getElementById("password"),error=document.getElementById("error"),ok=document.getElementById("ok");
let settle=null,waitUntil=0,ticker=0,said="";
const waiting=()=>waitUntil>Date.now();
const show=()=>{const left=Math.ceil((waitUntil-Date.now())/1000);if(left>0){error.textContent=(said?said+" ":"")+"Try again in "+left+" s.";ok.disabled=true;return;}clearInterval(ticker);ticker=0;error.textContent=said?said+" Try again.":"";ok.disabled=!settle;};
window.nextAnswer=()=>new Promise((resolve)=>{settle=resolve;ok.disabled=waiting();field.disabled=false;field.focus();});
const answer=(value)=>{if(!settle)return;const done=settle;settle=null;ok.disabled=true;field.disabled=true;done(value);};
form.addEventListener("submit",(event)=>{event.preventDefault();if(field.value&&!waiting())answer(field.value);});
document.getElementById("cancel").addEventListener("click",()=>answer(null));
addEventListener("keydown",(event)=>{if(event.key==="Escape")answer(null);});
window.refuse=(message,retryInMs)=>{field.value="";said=message;waitUntil=Date.now()+retryInMs;clearInterval(ticker);ticker=retryInMs>0?setInterval(show,250):0;show();if(!message)return;form.classList.remove("shake");void form.offsetWidth;form.classList.add("shake");};`,
});

const unavailablePage = (reason: string): PageText => ({
  heading: "Ardia can't check your login password on this system.",
  detail: `It needs your login password to ${escapeHtml(reason)}.`,
  form: `<form id="form"><div class="buttons"><button type="submit" class="primary" id="ok" autofocus>OK</button></div></form>`,
  script: `const ok=document.getElementById("ok");
let settle=null;
window.dismissed=()=>new Promise((resolve)=>{settle=resolve;ok.focus();});
const dismiss=()=>{if(settle)settle(true);settle=null;};
document.getElementById("form").addEventListener("submit",(event)=>{event.preventDefault();dismiss();});
addEventListener("keydown",(event)=>{if(event.key==="Escape")dismiss();});`,
});

function page(text: PageText, dark: boolean): string {
  const fg = dark ? "#e8eaed" : "#1d1d1f";
  const muted = dark ? "#9aa0a6" : "#6e6e73";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ardia</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
:root{color-scheme:${dark ? "dark" : "light"};font:13px system-ui,sans-serif}
body{margin:0;padding:22px 24px 18px;background:${dark ? "#2b2c2f" : "#f5f5f7"};color:${fg};user-select:none}
h1{font-size:14px;font-weight:600;margin:0 0 6px}
p{margin:0 0 14px;color:${muted};line-height:1.4}
input{box-sizing:border-box;width:100%;font:inherit;padding:7px 9px;border-radius:7px;border:1px solid ${dark ? "#5f6368" : "#c7c7cc"};background:${dark ? "#202124" : "#fff"};color:inherit;outline:none}
input:focus{border-color:#0a84ff;box-shadow:0 0 0 3px ${dark ? "rgba(10,132,255,.35)" : "rgba(10,132,255,.25)"}}
.error{height:16px;margin:6px 0 8px;color:#ff453a;font-size:12px}
.buttons{display:flex;justify-content:flex-end;gap:8px}
button{font:inherit;padding:6px 16px;border-radius:7px;border:1px solid ${dark ? "#5f6368" : "#c7c7cc"};background:${dark ? "#3c4043" : "#fff"};color:inherit}
button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
button:disabled{opacity:.5}
@keyframes shake{0%,100%{transform:none}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
.shake{animation:shake .18s 2}
</style></head><body>
<h1>${text.heading}</h1>
<p>${text.detail}</p>
${text.form}
<script>
${text.script}
</script></body></html>`;
}

function openWindow(text: PageText): BrowserWindow {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    parent,
    modal: !!parent,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: "Ardia",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#2b2c2f" : "#f5f5f7",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(text, nativeTheme.shouldUseDarkColors))}`);
  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    window.show();
    window.focus();
  });
  return window;
}

const loaded = (window: BrowserWindow) =>
  new Promise<void>((resolve) => {
    if (!window.webContents.isLoading()) return resolve();
    window.webContents.once("did-finish-load", () => resolve());
    window.once("closed", () => resolve());
  });

function promptIn(window: BrowserWindow): OwnerPrompt {
  const run = (script: string) => (window.isDestroyed() ? Promise.resolve(undefined) : window.webContents.executeJavaScript(script, true));
  return {
    answer: () => {
      if (window.isDestroyed()) return Promise.resolve(null);
      const closed = new Promise<null>((resolve) => window.once("closed", () => resolve(null)));
      const answered = run("window.nextAnswer()").then(
        (value: unknown) => (typeof value === "string" && value ? value : null),
        () => null,
      );
      return Promise.race([answered, closed]);
    },
    refuse: (message, retryInMs) => run(`window.refuse(${JSON.stringify(message)}, ${Math.max(0, Math.round(retryInMs))})`).then(
      () => undefined,
      () => undefined,
    ),
    focus: () => {
      if (!window.isDestroyed()) window.focus();
    },
    close: () => {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

export const windowPrompt: OwnerPromptUI = {
  ask: async (reason, retryInMs) => {
    const window = openWindow(passwordPage(reason));
    await loaded(window);
    const prompt = promptIn(window);
    if (retryInMs > 0) await prompt.refuse("", retryInMs);
    return prompt;
  },
  tellUnavailable: async (reason) => {
    const window = openWindow(unavailablePage(reason));
    await loaded(window);
    if (window.isDestroyed()) return;
    const closed = new Promise<void>((resolve) => window.once("closed", () => resolve()));
    const dismissed = window.webContents.executeJavaScript("window.dismissed()", true).then(
      () => undefined,
      () => undefined,
    );
    await Promise.race([dismissed, closed]);
    if (!window.isDestroyed()) window.destroy();
  },
};
