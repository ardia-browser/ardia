import { BrowserWindow, webContents as allContents, type Input, type WebContents } from "electron";
import { randomUUID } from "node:crypto";

const WIDTH = 236;
const HEIGHT = 48;
const TOP_INSET = 10;

const page = (token: string) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
html,body{margin:0;background:transparent;overflow:hidden;font:500 13px system-ui,sans-serif;user-select:none}
.pill{position:absolute;left:8px;right:8px;top:8px;height:32px;box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:0 4px 0 14px;border-radius:16px;background:rgba(0,0,0,.82);border:.5px solid rgba(255,255,255,.12);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.dot{width:8px;height:8px;border-radius:50%;background:#ff3b30;flex:none}
.time{color:rgba(255,255,255,.7);font-variant-numeric:tabular-nums}
.label{flex:1;display:flex;gap:6px}
button{display:flex;align-items:center;gap:5px;height:24px;padding:0 10px;border:0;border-radius:12px;background:rgba(255,255,255,.16);color:#fff;font:600 13px system-ui,sans-serif}
button i{width:8px;height:8px;border-radius:1.5px;background:#fff}
</style></head><body><div class="pill"><span class="dot"></span><span class="label">Recording <span class="time" id="time">0:00</span></span><button id="stop" aria-label="Stop recording"><i></i>Stop</button></div>
<script>
window.setSeconds=(seconds)=>{document.getElementById("time").textContent=Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0");};
document.getElementById("stop").onclick=()=>{document.title=${JSON.stringify(token)};};
</script></body></html>`;

export type RecordingPill = { setSeconds(seconds: number): void; close(): void };

export function showRecordingPill(over: BrowserWindow, onStop: () => void): RecordingPill {
  const token = randomUUID();
  const pill = new BrowserWindow({
    parent: over,
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const place = () => {
    if (pill.isDestroyed() || over.isDestroyed()) return;
    const bounds = over.getBounds();
    pill.setPosition(Math.round(bounds.x + (bounds.width - WIDTH) / 2), bounds.y + TOP_INSET);
  };
  const escape = (event: Electron.Event, input: Input) => {
    if (input.type === "keyDown" && input.key === "Escape" && !input.control && !input.alt && !input.shift && !input.meta) {
      event.preventDefault();
      onStop();
    }
  };
  const watched: WebContents[] = allContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents !== pill.webContents);
  for (const contents of watched) contents.on("before-input-event", escape);
  over.on("move", place);
  over.on("resize", place);
  pill.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    if (title === token) onStop();
  });
  pill.webContents.on("will-navigate", (event) => event.preventDefault());
  pill.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  pill.once("ready-to-show", () => {
    place();
    pill.showInactive();
  });
  void pill.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(token))}`);
  return {
    setSeconds: (seconds) => {
      if (!pill.isDestroyed()) void pill.webContents.executeJavaScript(`window.setSeconds && window.setSeconds(${Math.max(0, Math.floor(seconds))})`, false).catch(() => {});
    },
    close: () => {
      for (const contents of watched) if (!contents.isDestroyed()) contents.off("before-input-event", escape);
      if (!over.isDestroyed()) {
        over.off("move", place);
        over.off("resize", place);
      }
      if (!pill.isDestroyed()) pill.destroy();
    },
  };
}
