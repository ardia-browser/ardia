import { BrowserWindow, nativeTheme } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { count } from "./counts";
import { testValue } from "./launch";
import { note } from "./log";
import { isBackground } from "./paths";

const PASSWORD_HELPERS = ["/usr/sbin/unix_chkpwd", "/sbin/unix_chkpwd", "/usr/bin/unix_chkpwd"];
const HELPER_DEADLINE_MS = 15_000;
const GRANT_REUSE_MS = 60_000;
const WIDTH = 440;
const HEIGHT = 196;

let grantedAt = 0;
let asking: Promise<boolean> | null = null;
let askingWindow: BrowserWindow | null = null;

const passwordHelper = () => PASSWORD_HELPERS.find((path) => existsSync(path)) ?? null;

function passwordMatches(helper: string, password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(helper, [userInfo().username, "nonull"], { stdio: ["pipe", "ignore", "ignore"] });
    const deadline = setTimeout(() => child.kill("SIGKILL"), HELPER_DEADLINE_MS);
    child.once("error", () => {
      clearTimeout(deadline);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      resolve(code === 0);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.concat([Buffer.from(password, "utf8"), Buffer.from([0])]));
  });
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(reason: string, dark: boolean): string {
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
<h1>Ardia wants to ${escapeHtml(reason)}.</h1>
<p>Enter your login password to allow this.</p>
<form id="form"><input id="password" type="password" autocomplete="current-password" aria-label="Login password" autofocus>
<div class="error" id="error"></div>
<div class="buttons"><button type="button" id="cancel">Cancel</button><button type="submit" class="primary" id="ok">OK</button></div></form>
<script>
const form=document.getElementById("form"),field=document.getElementById("password"),error=document.getElementById("error"),ok=document.getElementById("ok");
let settle=null;
window.nextAnswer=()=>new Promise((resolve)=>{settle=resolve;ok.disabled=false;field.disabled=false;field.focus();});
const answer=(value)=>{if(!settle)return;const done=settle;settle=null;ok.disabled=true;field.disabled=true;done(value);};
form.addEventListener("submit",(event)=>{event.preventDefault();if(field.value)answer(field.value);});
document.getElementById("cancel").addEventListener("click",()=>answer(null));
addEventListener("keydown",(event)=>{if(event.key==="Escape")answer(null);});
window.wrongPassword=()=>{field.value="";error.textContent="Wrong password. Try again.";form.classList.remove("shake");void form.offsetWidth;form.classList.add("shake");};
</script></body></html>`;
}

function openPrompt(reason: string): BrowserWindow {
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
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(reason, nativeTheme.shouldUseDarkColors))}`);
  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    window.show();
    window.focus();
  });
  return window;
}

async function nextAnswer(window: BrowserWindow): Promise<string | null> {
  if (window.isDestroyed()) return null;
  const closed = new Promise<null>((resolve) => window.once("closed", () => resolve(null)));
  const answered = window.webContents.executeJavaScript("window.nextAnswer()", true).then(
    (value: unknown) => (typeof value === "string" && value ? value : null),
    () => null,
  );
  return Promise.race([answered, closed]);
}

async function askForPassword(helper: string, reason: string): Promise<boolean> {
  const window = openPrompt(reason);
  askingWindow = window;
  await new Promise<void>((resolve) => {
    if (!window.webContents.isLoading()) return resolve();
    window.webContents.once("did-finish-load", () => resolve());
    window.once("closed", () => resolve());
  });
  try {
    for (;;) {
      const password = await nextAnswer(window);
      if (password === null) return false;
      if (await passwordMatches(helper, password)) return true;
      count("owner_check_wrong_passwords");
      if (window.isDestroyed()) return false;
      await window.webContents.executeJavaScript("window.wrongPassword()", true).catch(() => {});
    }
  } finally {
    askingWindow = null;
    if (!window.isDestroyed()) window.destroy();
  }
}

async function check(reason: string): Promise<boolean> {
  const answer = testValue("reauth");
  if (answer !== undefined) {
    note("owner", `device owner check (${reason}) in a test instance: ${answer === "denied" ? "denied" : "granted"}`);
    return answer !== "denied";
  }
  if (isBackground()) {
    note("owner", `device owner check (${reason}) in a background instance: granted`);
    return true;
  }
  const helper = passwordHelper();
  if (!helper) {
    count("owner_check_unavailable");
    note("owner", `device owner check (${reason}): no unix_chkpwd on this system, so nothing can check the login password; granted`);
    return true;
  }
  count("owner_check_asked");
  const granted = await askForPassword(helper, reason);
  count(granted ? "owner_check_granted" : "owner_check_cancelled");
  return granted;
}

export function confirmDeviceOwner(reason: string): Promise<boolean> {
  if (Date.now() - grantedAt < GRANT_REUSE_MS) return Promise.resolve(true);
  if (asking) {
    if (askingWindow && !askingWindow.isDestroyed()) askingWindow.focus();
    return asking;
  }
  asking = check(reason)
    .catch(() => false)
    .then((granted) => {
      if (granted) grantedAt = Date.now();
      return granted;
    })
    .finally(() => {
      asking = null;
    });
  return asking;
}
