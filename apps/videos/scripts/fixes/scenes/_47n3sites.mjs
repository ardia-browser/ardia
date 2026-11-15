import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../capture/sites");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".mp4": "video/mp4", ".wav": "audio/wav" };
const dot = (accent) => `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23${accent}'/%3E%3C/svg%3E`;
const shell = (title, accent, style, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="${dot(accent)}">
<style>*{box-sizing:border-box}body{margin:0;font:15px system-ui,-apple-system,sans-serif;background:#f6f4ef;color:#222}header{height:72px;padding:22px 40px;background:#${accent};color:#fff;font-size:22px;font-weight:600}${style}</style></head><body>${body}</body></html>`;

const FILES = [
  ["Trail map.pdf", "application/pdf"],
  ["Packing list.txt", "text/plain"],
  ["Ferry times.csv", "text/csv"],
];
const CHUNK = 32768;
const CHUNKS = 24;
const progress = new Map();

const filesPage = shell("Field Kit — Downloads", "2f6f4f", `
header{height:44px;padding:11px 24px;font-size:18px}main{padding:18px 24px}
a.file{position:relative;display:flex;align-items:center;gap:14px;width:380px;height:58px;margin-bottom:10px;padding:0 18px;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1);color:#1b1b1b;text-decoration:none;overflow:hidden}
a.file i{font-style:normal;font-size:20px;width:26px;text-align:center}a.file b{flex:1;font-size:18px;font-weight:600}
a.file u{position:absolute;left:0;bottom:0;height:6px;width:0;background:#2f9e5f;text-decoration:none}a.file s{text-decoration:none;font-size:22px;font-weight:800;color:#2f9e5f;opacity:0}
a.file.done s{opacity:1}.count{margin-top:16px;display:flex;align-items:baseline;gap:14px;font-size:24px;color:#555;font-weight:600}.count b{font-size:96px;line-height:1;color:#1f6f45;font-variant-numeric:tabular-nums}`,
`<header>Field Kit · Downloads</header><main>${FILES.map(([name], i) => `<a class="file" data-i="${i}" download="${name}"><i>⬇︎</i><b>${name}</b><s>✓</s><u></u></a>`).join("")}
<div class="count"><b id="n">0</b><span>of 3 downloading</span></div></main>
<script>
const sid=Math.random().toString(36).slice(2);const rows=[...document.querySelectorAll("a.file")];
rows.forEach((a)=>{a.href="/file/"+a.dataset.i+"?sid="+sid;});
setInterval(()=>fetch("/progress?sid="+sid,{cache:"no-store"}).then((r)=>r.json()).then((p)=>{let n=0;rows.forEach((a,i)=>{const f=p[i]||0;if(f>0)n++;a.querySelector("u").style.width=(f*100)+"%";a.classList.toggle("done",f>=1);});document.getElementById("n").textContent=n;}).catch(()=>{}),120);
</script>`);

const widthPage = shell("Page width", "5b3fa0", `
main{padding:34px 44px}.big{font:700 120px/1 system-ui,-apple-system,sans-serif;letter-spacing:-.03em;font-variant-numeric:tabular-nums}.big small{font-size:40px;color:#888;font-weight:600;margin-left:10px}
.row{margin-top:26px;display:flex;gap:16px;flex-wrap:wrap}.chip{padding:14px 20px;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);font-size:19px;font-variant-numeric:tabular-nums}
.chip b{display:block;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}.over{background:#ffe3df;color:#b3261e}
#bar{position:fixed;left:0;right:0;bottom:0;height:16px;background:repeating-linear-gradient(90deg,#5b3fa0 0 1px,transparent 1px 10px),repeating-linear-gradient(90deg,#5b3fa0 0 2px,transparent 2px 100px);opacity:.5}
#edge{position:fixed;top:0;bottom:0;right:0;width:4px;background:#5b3fa0}`,
`<header>Page width</header><main><div class="big"><span id="w"></span><small>pt wide</small></div>
<div class="row"><div class="chip"><b>Slide</b><span id="path">–</span></div><div class="chip" id="oc"><b>Past the end</b><span id="over">–</span></div><div class="chip"><b>Settled widths</b><span id="hist">–</span></div></div></main><div id="bar"></div><div id="edge"></div>
<script>
const w=document.getElementById("w"),path=document.getElementById("path"),over=document.getElementById("over"),oc=document.getElementById("oc"),hist=document.getElementById("hist");
let last=innerWidth,start=null,seen=[],idle=null;const settled=[innerWidth];
const show=()=>{hist.textContent=settled.slice(-5).join(" · ")};show();
function tick(){const now=innerWidth;w.textContent=now;if(now!==last){if(start===null){start=last;seen=[last];}seen.push(now);last=now;clearTimeout(idle);idle=setTimeout(finish,500);path.textContent=start+" → "+now;}
requestAnimationFrame(tick);}
function finish(){const end=last,dir=Math.sign(end-start),ext=dir>0?Math.max(...seen):Math.min(...seen),past=Math.abs(ext-end);
path.textContent=start+" → "+(past?ext+" → ":"")+end;over.textContent=past?past+" pt, then back":"none";oc.classList.toggle("over",past>0);settled.push(end);show();start=null;}
tick();
</script>`);

const tidePage = shell("Morning tide — Clips", "1d4e89", `
body{background:#0f1720;color:#fff}main{display:flex;flex-direction:column;align-items:center;padding-top:40px;gap:16px}video{width:70vw;max-width:900px;border-radius:14px;box-shadow:0 30px 60px rgba(0,0,0,.5)}
h1{font-size:24px;width:70vw;max-width:900px;margin:0}p{width:70vw;max-width:900px;margin:-6px 0 0;opacity:.6}`,
`<header>Clips</header><main><video id="v" src="/img/tide.mp4" autoplay loop playsinline></video><h1>Morning tide</h1><p>Harbor Cam · loops every 6 seconds</p></main>
<script>const v=document.getElementById("v");v.volume=0.05;navigator.mediaSession.metadata=new MediaMetadata({title:"Morning tide",artist:"Harbor Cam",album:"Clips"});const go=()=>v.play().catch(()=>{});go();addEventListener("click",go);</script>`);

const notesPage = (title) => shell(`${title} — Docpad`, "c2410c", `main{padding:34px 44px;font-size:18px;line-height:1.6}`, `<header>Docpad</header><main><h1>${title}</h1><p>Ferry at 9:10 from Pier 3. Bring the trail map and two litres of water each.</p></main>`);

const SYNTHETIC = {
  "files.example": { "/": filesPage },
  "width.example": { "/": widthPage },
  "tide.example": { "/": tidePage },
  "docpad.example": { "/packing": notesPage("Packing list") },
};

createServer((req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  if (host === "files.example" && path === "/progress") {
    const sid = new URL(req.url, "http://x").searchParams.get("sid");
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(progress.get(sid) ?? {}));
  }
  if (host === "files.example" && path.startsWith("/file/")) {
    const i = Number(path.slice(6));
    const [name, type] = FILES[i] ?? FILES[0];
    const sid = new URL(req.url, "http://x").searchParams.get("sid") ?? "";
    const mine = progress.get(sid) ?? {};
    progress.set(sid, mine);
    const chunk = Buffer.alloc(CHUNK, 46);
    res.writeHead(200, { "content-type": type, "content-disposition": `attachment; filename="${name}"`, "content-length": CHUNK * CHUNKS, "cache-control": "no-store" });
    let sent = 0;
    mine[i] = 0.02;
    const timer = setInterval(() => {
      res.write(chunk);
      mine[i] = ++sent / CHUNKS;
      if (sent === CHUNKS) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
    return res.on("close", () => clearInterval(timer));
  }
  const synthetic = SYNTHETIC[host]?.[path];
  if (synthetic) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(synthetic);
  }
  let file = join(root, host, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!file.startsWith(join(root, host)) || !existsSync(file)) {
    res.writeHead(404);
    return res.end("not found");
  }
  const body = readFileSync(file);
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  const type = types[extname(file)] || "application/octet-stream";
  if (range) {
    const from = Number(range[1]);
    const to = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${from}-${to}/${body.length}`, "accept-ranges": "bytes", "content-length": to - from + 1 });
    return res.end(body.subarray(from, to + 1));
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" });
  res.end(body);
}).listen(Number(process.argv[2] || 47273), "127.0.0.1");
