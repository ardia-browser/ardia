import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { prepareApp } from "../../../scripts/lib/app-copy.mjs";
import { launch, session } from "../../../scripts/lib/instance.mjs";

const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: { bundle: { type: "string" }, out: { type: "string" }, port: { type: "string" } } });
if (!positionals[0]) {
  console.error("usage: node capture-test.mjs <Ardia.app> [--bundle <main.jsbundle>] [--out <dir>]");
  process.exit(2);
}
const out = resolve(flags.out ?? join(tmpdir(), "ac-capture"));
mkdirSync(out, { recursive: true });
const app = flags.bundle ? prepareApp(positionals[0], join(out, "app"), { bundle: resolve(flags.bundle) }) : resolve(positionals[0]);
const dataDir = join(out, "data");
const downloads = join(out, "downloads");
mkdirSync(downloads, { recursive: true });

const html = `<title>Capture</title><style>html,body{margin:0;background:rgb(255,255,255)}
#card{position:absolute;left:100px;top:80px;width:300px;height:200px;background:rgb(220,0,0)}
#pic{position:absolute;left:20px;top:20px;width:160px;height:120px;display:block}
p{margin:0}</style><div id=card><canvas id=pic width=160 height=120></canvas></div>
<script>const c=document.getElementById('pic').getContext('2d');c.fillStyle='rgb(0,0,220)';c.fillRect(0,0,160,120)</script>`;
const page = `data:text/html,${encodeURIComponent(html)}`;
const other = `data:text/html,${encodeURIComponent("<title>Other</title><p>other</p>")}`;
const cards = `data:text/html,${encodeURIComponent("<title>Cards</title><style>html,body{margin:0;height:2000px}#one{position:absolute;left:50px;top:100px;width:300px;height:200px;background:rgb(220,0,0)}#two{position:absolute;left:100px;top:500px;width:200px;height:150px;background:rgb(0,0,220)}</style><div id=one></div><div id=two></div>")}`;
const tall = `data:text/html,${encodeURIComponent("<title>Tall</title><style>html,body{margin:0}div{height:1000px}</style><div style='background:rgb(220,0,0)'></div><div style='background:rgb(0,160,0)'></div><div style='background:rgb(0,0,220)'></div>")}`;

const instance = await launch(app, {
  data: dataDir,
  instance: { downloadsDir: downloads },
  fresh: true,
  port: flags.port,
  onboarded: true,
  probe: true,
  session: session({
    windows: [{ id: "w1", frame: [100, 100, 1100, 760] }],
    tabs: [
      { id: "a", url: page, title: "Capture" },
      { id: "b", url: other, title: "Other" },
      { id: "c", url: tall, title: "Tall" },
      { id: "d", url: cards, title: "Cards" },
    ],
    settings: { searchSuggestions: false, warnBeforeClosingLastTab: false, warnBeforeClosingWindow: false },
  }),
  ready: { timeout: 120_000, test: "return !!ac.store.getState().windows.w1;" },
});
const ac = (body, ms = 60_000) => instance.eval(body, { timeout: ms });
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
};

const pasteboardNames = [...new Set([dataDir, realpathSync(dataDir)].flatMap((dir) => [dir, dir.replace(/^\/private\//, "/")]))].map((dir) => `com.ardia.scratch:${dir}`);
const pngPath = join(out, "clipboard.png");
function readPasteboard() {
  rmSync(pngPath, { force: true });
  const script = `ObjC.import("AppKit");
    const names = ${JSON.stringify(pasteboardNames)};
    let found = "none";
    for (const name of names) {
      const board = $.NSPasteboard.pasteboardWithName(name);
      const data = board.dataForType("public.png");
      if (data && !data.isNil()) {
        data.writeToFileAtomically(${JSON.stringify(pngPath)}, true);
        const rep = $.NSBitmapImageRep.imageRepWithData(data);
        const pick = (fx, fy) => {
          const color = rep.colorAtXY(Math.floor(Number(rep.pixelsWide) * fx), Math.floor(Number(rep.pixelsHigh) * fy));
          return [color.redComponent, color.greenComponent, color.blueComponent].map((v) => Math.round(v * 255));
        };
        found = JSON.stringify({ count: Number(board.changeCount), space: rep.colorSpace.localizedName.js, width: Number(rep.pixelsWide), height: Number(rep.pixelsHigh), center: pick(0.5, 0.5), corner: pick(0.97, 0.97) });
        break;
      }
      found = JSON.stringify({ count: Number(board.changeCount) });
    }
    found;`;
  return JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8" }).trim());
}

const near = (rgb, want) => rgb && rgb.every((v, i) => Math.abs(v - want[i]) <= 12);

try {
  await ac(`
    globalThis.audit = {
      frames: (n) => new Promise((r) => { let k = n || 2; const step = () => (k-- > 0 ? requestAnimationFrame(step) : r()); step(); }),
      until: (test, ms) => new Promise((r) => { const end = Date.now() + (ms || 15000); const poll = () => (test() ? r(true) : Date.now() > end ? r(false) : setTimeout(poll, 50)); poll(); }),
      toast: () => ac.toasts.getState().toasts.w1 || null,
      clear: () => ac.toasts.setState({ toasts: {} }),
      start: () => { audit.clear(); return ac.shell.devMenuCommand("capture", null).then(() => new Promise((r) => setTimeout(r, 600))); },
      settle: (ms) => new Promise((r) => setTimeout(r, ms || 600)),
      key: (keyCode, key) => ac.shell.devKeyEquivalent("w1", { key, keyCode, send: true, asKey: true, wait: 150 }),
    };
    return true;`);
  const S = "const S = () => ac.store.getState();";
  const loaded = await ac(`${S} S().activate("a"); return audit.until(() => S().tabs.a.title === "Capture" && ac.webviews.has("a"), 30000).then((ok) => audit.settle(800).then(() => ok));`);
  check("the test page is up", loaded === true);
  const scale = await ac(`return ac.webviews.get("a").evaluate("post('result', JSON.stringify(devicePixelRatio))");`);

  const dragOn = (from, to) => `ac.shell.devPointer("w1", [{ type: "down", x: ${from[0]}, y: ${from[1]} }, { type: "drag", x: ${(from[0] + to[0]) / 2}, y: ${(from[1] + to[1]) / 2} }, { type: "drag", x: ${to[0]}, y: ${to[1]} }, { type: "up", x: ${to[0]}, y: ${to[1]}, wait: 700 }])`;

  const red = await ac(`return audit.start().then(() => ${dragOn([300, 100], [390, 270])}).then(() => audit.toast());`);
  const shotA = readPasteboard();
  check("a drag copies exactly the dragged area, at the screen's scale", red?.title === "Capture copied" && shotA.width === 90 * scale && shotA.height === 170 * scale, `${JSON.stringify(red)} ${shotA.width}×${shotA.height} @${scale}x`);
  check("the copy is the page's pixels in sRGB (the red card)", shotA.space === "sRGB IEC61966-2.1" && near(shotA.center, [220, 0, 0]), `${shotA.space} ${JSON.stringify(shotA.center)}`);

  const hovered = await ac(`return audit.start()
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 200, y: 160, wait: 500 }, { type: "down", x: 200, y: 160 }, { type: "up", x: 200, y: 160, wait: 600 }]))
    .then((r) => ({ responder: r.firstResponder, toast: audit.toast() }));`);
  const shotHover = readPasteboard();
  check("hover then click copies the canvas under the pointer", hovered.toast?.title === "Capture copied" && shotHover.width === 160 * scale && shotHover.height === 120 * scale, `${JSON.stringify(hovered.toast)} ${shotHover.width}×${shotHover.height} @${scale}x`);
  check("the copy is the page's pixels in sRGB (blue canvas)", shotHover.space === "sRGB IEC61966-2.1" && near(shotHover.center, [0, 0, 220]), `${shotHover.space} ${JSON.stringify(shotHover.center)}`);

  const clickOnly = await ac(`return audit.start()
    .then(() => ac.shell.devPointer("w1", [{ type: "down", x: 360, y: 260 }, { type: "up", x: 360, y: 260, wait: 800 }]))
    .then(() => audit.toast());`);
  const shotB = readPasteboard();
  check("a click with no hover first still takes the block under it", clickOnly?.title === "Capture copied" && shotB.width === 300 * scale && shotB.height === 200 * scale, `${shotB.width}×${shotB.height}`);
  check("that block is the red card", near(shotB.corner, [220, 0, 0]), JSON.stringify(shotB.corner));

  const quick = await ac(`return audit.start()
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 200, y: 160, wait: 0 }, { type: "down", x: 360, y: 260, wait: 0 }, { type: "up", x: 360, y: 260, wait: 900 }]))
    .then(() => audit.toast());`);
  const shotQ = readPasteboard();
  check("a quick click on another block, while the last lookup is still out, takes the clicked block", quick?.title === "Capture copied" && shotQ.width === 300 * scale && near(shotQ.corner, [220, 0, 0]), `${shotQ.width}×${shotQ.height} ${JSON.stringify(shotQ.corner)}`);

  const stepped = await ac(`return audit.start()
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 200, y: 160, wait: 500 }]))
    .then(() => audit.key(126, "\\uf700"))
    .then((up) => audit.settle(200).then(() => audit.key(36, "\\r")).then((enter) => audit.settle(600).then(() => ({ up, enter, toast: audit.toast() }))));`);
  const shotC = readPasteboard();
  check("↑ steps out from the canvas to the card, Return takes it", stepped.toast?.title === "Capture copied" && shotC.width === 300 * scale && shotC.height === 200 * scale, `${shotC.width}×${shotC.height}`);

  const patched = await ac(`return ac.webviews.get("a").evaluate("window.keptLookup = [Document.prototype.elementsFromPoint, JSON.stringify]; Document.prototype.elementsFromPoint = function () { return []; }; JSON.stringify = function () { return '{}'; }; post('result', 'true')")
    .then(() => audit.start())
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 200, y: 160, wait: 500 }, { type: "down", x: 200, y: 160 }, { type: "up", x: 200, y: 160, wait: 600 }]))
    .then(() => audit.toast())
    .then((t) => ac.webviews.get("a").evaluate("[Document.prototype.elementsFromPoint, JSON.stringify] = window.keptLookup; post('result', 'true')").then(() => t));`);
  const shotP = readPasteboard();
  check("the block lookup can't be broken by the page patching elementsFromPoint or JSON.stringify", patched?.title === "Capture copied" && shotP.width === 160 * scale && near(shotP.center, [0, 0, 220]), `${JSON.stringify(patched)} ${shotP.width}×${shotP.height}`);

  const stalled = await ac(`return audit.start()
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 200, y: 160, wait: 500 }]))
    .then(() => ac.webviews.get("a").evaluate("setTimeout(() => { const end = Date.now() + 5000; while (Date.now() < end) {} }, 0); post('result', 'true')"))
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 210, y: 170, wait: 100 }, { type: "down", x: 210, y: 170 }, { type: "up", x: 210, y: 170, wait: 0 }]))
    .then(() => { const clicked = Date.now(); return audit.until(() => audit.toast()?.title === "Capture copied", 2500).then((ok) => ({ ok, ms: Date.now() - clicked })); })
    .then((r) => audit.settle(4500).then(() => r));`);
  const shotL = readPasteboard();
  check("a click on the outlined block still copies it while the page is too busy to answer the lookup", stalled.ok && shotL.width === 160 * scale && near(shotL.center, [0, 0, 220]), `${JSON.stringify(stalled)} ${shotL.width}×${shotL.height}`);

  const nudged = await ac(`return audit.start()
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 200, y: 160, wait: 500 }, { type: "scroll", x: 200, y: 160, dy: 10, command: true, wait: 100 }, { type: "scroll", x: 200, y: 160, dy: 10, command: true, wait: 200 }]))
    .then(() => audit.key(36, "\\r"))
    .then(() => audit.settle(600))
    .then(() => audit.toast());`);
  const shotN = readPasteboard();
  check("a small ⌘-scroll doesn't step out of the block", nudged?.title === "Capture copied" && shotN.width === 160 * scale, `${shotN.width}×${shotN.height}`);

  const swiped = await ac(`return audit.start()
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 200, y: 160, wait: 500 }, { type: "scroll", x: 200, y: 160, dy: 45, command: true, wait: 60 }, { type: "scroll", x: 200, y: 160, dy: 45, command: true, wait: 300 }]))
    .then(() => audit.key(36, "\\r"))
    .then(() => audit.settle(600))
    .then(() => audit.toast());`);
  const shotW = readPasteboard();
  check("a fuller ⌘-swipe steps out to the card", swiped?.title === "Capture copied" && shotW.width === 300 * scale, `${shotW.width}×${shotW.height}`);

  const held = await ac(`return audit.start()
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 200, y: 160, wait: 500 }, { type: "scroll", x: 200, y: 160, dy: 45, command: true, wait: 60 }, { type: "scroll", x: 200, y: 160, dy: 45, command: true, wait: 300 }, { type: "move", x: 230, y: 175, wait: 150 }, { type: "move", x: 260, y: 190, wait: 600 }]))
    .then(() => audit.key(36, "\\r"))
    .then(() => audit.settle(600))
    .then(() => audit.toast());`);
  const shotH = readPasteboard();
  check("moving inside the block you stepped out to keeps that depth", held?.title === "Capture copied" && shotH.width === 300 * scale, `${shotH.width}×${shotH.height}`);

  const clickMoved = await ac(`return audit.start()
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 200, y: 160, wait: 0 }, { type: "down", x: 360, y: 260, wait: 0 }, { type: "up", x: 360, y: 260, wait: 0 }, { type: "move", x: 600, y: 500, wait: 0 }, { type: "move", x: 620, y: 520, wait: 900 }]))
    .then(() => audit.toast());`);
  const shotM = readPasteboard();
  check("a click still takes its block when the pointer moves on before the lookup answers", clickMoved?.title === "Capture copied" && shotM.width === 300 * scale && near(shotM.corner, [220, 0, 0]), `${JSON.stringify(clickMoved)} ${shotM.width}×${shotM.height}`);
  if (!clickMoved) await ac(`return audit.key(53, "\\u001b").then(() => audit.settle(300));`);

  const deeper = await ac(`return audit.start()
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 360, y: 260, wait: 600 }, { type: "move", x: 200, y: 160, wait: 0 }, { type: "down", x: 200, y: 160, wait: 0 }, { type: "up", x: 200, y: 160, wait: 900 }]))
    .then(() => audit.toast());`);
  const shotK = readPasteboard();
  check("a quick click on a smaller block inside the outlined one takes the smaller block", deeper?.title === "Capture copied" && shotK.width === 160 * scale && near(shotK.center, [0, 0, 220]), `${shotK.width}×${shotK.height} ${JSON.stringify(shotK.center)}`);
  if (!deeper) await ac(`return audit.key(53, "\\u001b").then(() => audit.settle(300));`);

  const dragged = await ac(`return audit.start().then(() => ${dragOn([30, 330], [230, 430])}).then(() => audit.toast());`);
  const shotD = readPasteboard();
  check("a drag over the page copies that part of it", dragged?.title === "Capture copied" && shotD.width === 200 * scale && shotD.height === 100 * scale && near(shotD.center, [255, 255, 255]), `${shotD.width}×${shotD.height} ${JSON.stringify(shotD.center)}`);

  const before = readPasteboard().count;
  const tiny = await ac(`return audit.start().then(() => ${dragOn([300, 120], [320, 140])}).then(() => audit.toast());`);
  const shotT = readPasteboard();
  check("a drag of 30 pt or less counts as a click and takes the block under it", tiny?.title === "Capture copied" && shotT.count !== before && shotT.width === 300 * scale && near(shotT.corner, [220, 0, 0]), `${shotT.width}×${shotT.height}`);
  await ac(`return audit.key(53, "\\u001b").then(() => audit.settle(300));`);

  const resized = await ac(`return audit.start()
    .then(() => ac.shell.devSetWindowFrame("w1", [100, 100, 1100, 720]))
    .then(() => audit.settle(700))
    .then(() => ${dragOn([300, 100], [390, 270])})
    .then(() => { const t = audit.toast(); return ac.shell.devSetWindowFrame("w1", [100, 100, 1100, 760]).then(() => audit.settle(500)).then(() => t); });`);
  const shotZ = readPasteboard();
  check("Capture stays up when the page changes size (the toolbar hiding on scroll, a window resize)", resized?.title === "Capture copied" && near(shotZ.center, [220, 0, 0]), `${shotZ.width}×${shotZ.height} ${JSON.stringify(shotZ.center)}`);

  const typed = await ac(`return audit.start()
    .then(() => ac.shell.devMenuCommand("focusCommandBar", null))
    .then(() => audit.settle(600))
    .then(() => audit.key(53, "\\u001b"))
    .then(() => audit.settle(500))
    .then(() => ${dragOn([300, 100], [390, 270])})
    .then(() => audit.toast());`);
  check("Esc typed into the command bar during Capture goes to the bar, and Capture stays up", typed?.title === "Capture copied", JSON.stringify(typed));
  if (!typed) await ac(`return audit.key(53, "\\u001b").then(() => audit.settle(300));`);

  const kept = readPasteboard().count;
  const escaped = await ac(`return audit.start()
    .then(() => audit.key(53, "\\u001b"))
    .then(() => audit.settle(400))
    .then(() => ${dragOn([300, 100], [390, 270])})
    .then(() => audit.toast());`);
  check("Esc leaves without copying, and a drag after it is the page's", escaped === null && readPasteboard().count === kept, JSON.stringify(escaped));

  const toggled = await ac(`return audit.start()
    .then(() => ac.shell.devMenuCommand("capture", null))
    .then(() => audit.settle(400))
    .then(() => ${dragOn([300, 100], [390, 270])})
    .then(() => audit.toast());`);
  check("⇧⌘2 again leaves without copying", toggled === null && readPasteboard().count === kept, JSON.stringify(toggled));

  const beforeNavigation = readPasteboard().count;
  const navigated = await ac(`${S} return audit.start()
    .then(() => ac.webviews.get("a").reload())
    .then(() => audit.settle(600))
    .then(() => audit.until(() => S().tabs.a.loading === false, 10000))
    .then(() => audit.settle(800))
    .then(() => ${dragOn([300, 100], [390, 270])})
    .then(() => audit.toast());`);
  check("the page loading a new document (a reload) ends Capture", navigated === null && readPasteboard().count === beforeNavigation, JSON.stringify(navigated));

  const spied = await ac(`${S} return audit.start()
    .then(() => ac.webviews.get("a").evaluate("location.hash = 'spy'; history.replaceState(null, '', '#spied'); const f = document.createElement('iframe'); f.id = 'late'; f.style.cssText = 'position:absolute;left:700px;top:500px;width:20px;height:20px;border:0'; f.src = 'data:text/html,late'; document.body.appendChild(f); post('result', 'true')"))
    .then(() => audit.until(() => S().tabs.a.url.endsWith("#spied"), 5000))
    .then(() => audit.settle(800))
    .then(() => ${dragOn([300, 100], [390, 270])})
    .then(() => audit.toast())
    .then((t) => ac.webviews.get("a").evaluate("document.getElementById('late').remove(); post('result', 'true')").then(() => t));`);
  check("a hash change, replaceState or a frame loading keeps Capture up", spied?.title === "Capture copied", JSON.stringify(spied));

  const beforeSwitch = readPasteboard().count;
  const switched = await ac(`${S} return audit.start()
    .then(() => { S().activate("b"); return audit.settle(400); })
    .then(() => { S().activate("a"); return audit.settle(600); })
    .then(() => ${dragOn([300, 100], [390, 270])})
    .then(() => audit.toast());`);
  check("showing another tab ends it", switched === null && readPasteboard().count === beforeSwitch, JSON.stringify(switched));

  const paint = (color) => `ac.webviews.get("a").evaluate("document.getElementById('card').style.background = '${color}'; post('result', 'true')")`;
  const repainted = await ac(`return audit.start()
    .then(() => ${paint("rgb(0,160,0)")})
    .then(() => audit.settle(400))
    .then(() => ac.shell.devPointer("w1", [{ type: "down", x: 360, y: 260 }, { type: "up", x: 360, y: 260, wait: 900 }]))
    .then(() => { const t = audit.toast(); return ${paint("rgb(220,0,0)")}.then(() => audit.settle(300)).then(() => t); });`);
  const shotR = readPasteboard();
  check("a clicked block is copied as it is now, not as it was when Capture froze the page", repainted?.title === "Capture copied" && near(shotR.corner, [0, 160, 0]), JSON.stringify(shotR.corner));

  const saved = await ac(`return audit.start()
    .then(() => ${dragOn([300, 100], [390, 270])})
    .then(() => { const t = audit.toast(); t && t.action && t.action.run(); return audit.until(() => audit.toast()?.title === "Capture saved", 5000); })
    .then(() => audit.toast());`);
  check("Save writes the capture to the downloads folder", saved?.title === "Capture saved" && /^Capture .+\.png$/.test(saved.message ?? ""), JSON.stringify(saved));

  const savedTwice = await ac(`return audit.start()
    .then(() => ${dragOn([300, 100], [390, 270])})
    .then(() => { const first = audit.toast(); return audit.start().then(() => ${dragOn([30, 330], [230, 430])}).then(() => { if (first && first.action) first.action.run(); return audit.until(() => audit.toast()?.title === "Capture saved", 5000); }); })
    .then(() => audit.toast());`);
  const savedFile = savedTwice?.message ? join(downloads, savedTwice.message) : "";
  const sipsOut = savedFile && existsSync(savedFile) ? execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", savedFile], { encoding: "utf8" }) : "";
  const savedSize = [/pixelWidth: (\d+)/, /pixelHeight: (\d+)/].map((pattern) => Number(sipsOut.match(pattern)?.[1] ?? 0));
  check("Save on an earlier toast saves that capture, after another one", savedTwice?.title === "Capture saved" && savedSize[0] === 90 * scale && savedSize[1] === 170 * scale, `${JSON.stringify(savedTwice)} ${savedSize.join("×")}`);

  const listPngs = () => execFileSync("ls", [downloads], { encoding: "utf8" }).split("\n").filter((name) => name.endsWith(".png"));
  const pngsBefore = listPngs().length;
  const savedAtOnce = await ac(`return audit.start()
    .then(() => ${dragOn([300, 100], [390, 270])})
    .then(() => { const t = audit.toast(); const seen = []; const off = ac.toasts.subscribe((s) => { const now = s.toasts.w1?.title; if (now && seen[seen.length - 1] !== now) seen.push(now); }); t && t.action && (t.action.run(), t.action.run()); return audit.settle(1500).then(() => (off(), seen)); });`);
  const pngsAfter = listPngs().length;
  check("two Saves in the same second both write a file", pngsAfter - pngsBefore === 2 && !savedAtOnce.includes("Couldn't save the capture"), `${pngsAfter - pngsBefore} new, ${JSON.stringify(savedAtOnce)}`);

  const scrolled = await ac(`${S} S().activate("c");
    return audit.until(() => S().tabs.c.title === "Tall" && ac.webviews.has("c"), 20000)
      .then(() => audit.settle(800))
      .then(() => audit.start())
      .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 300, y: 300, wait: 300 }].concat(Array.from({ length: 4 }, () => ({ type: "scroll", x: 300, y: 300, dy: -300, wait: 60 }))).concat([{ type: "move", x: 301, y: 300, wait: 900 }])))
      .then(() => ac.webviews.get("c").evaluate("post('result', JSON.stringify(scrollY))"))
      .then((y) => ${dragOn([100, 200], [300, 320])}.then(() => ({ y, toast: audit.toast() })))
      .then((r) => ac.webviews.get("c").evaluate("scrollTo(0, 0); post('result', 'true')").then(() => r));`);
  const shotS = readPasteboard();
  check("scrolling scrolls the page under Capture, and what you drag over is what's there now", scrolled.y >= 1000 && scrolled.toast?.title === "Capture copied" && near(shotS.center, [0, 160, 0]), `scrollY ${scrolled.y} ${JSON.stringify(shotS.center)}`);
  const afterScroll = await ac(`${S} S().activate("d");
    return audit.until(() => S().tabs.d.title === "Cards" && ac.webviews.has("d"), 20000)
      .then(() => audit.settle(800))
      .then(() => audit.start())
      .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 150, y: 200, wait: 600 }, { type: "scroll", x: 150, y: 200, dy: -380, wait: 0 }, { type: "down", x: 150, y: 200, wait: 0 }, { type: "up", x: 150, y: 200, wait: 1200 }]))
      .then(() => audit.toast());`);
  const shotA2 = readPasteboard();
  check("a click right after a scroll takes the block now under the pointer", afterScroll?.title === "Capture copied" && shotA2.width === 200 * scale && near(shotA2.center, [0, 0, 220]), `${shotA2.width}×${shotA2.height} ${JSON.stringify(shotA2.center)}`);
  if (!afterScroll) await ac(`return audit.key(53, "\\u001b").then(() => audit.settle(300));`);
  const steppedAfterScroll = await ac(`return ac.webviews.get("d").evaluate("scrollTo(0, 0); post('result', 'true')")
    .then(() => audit.settle(400))
    .then(() => audit.start())
    .then(() => ac.shell.devPointer("w1", [{ type: "move", x: 150, y: 200, wait: 600 }, { type: "scroll", x: 150, y: 200, dy: -380, wait: 0 }]))
    .then(() => audit.key(126, "\\uf700"))
    .then(() => audit.key(36, "\\r"))
    .then(() => audit.settle(1200))
    .then(() => audit.toast());`);
  const shotU = readPasteboard();
  check("↑ and Return right after a scroll take the block now under the pointer, not where it was", steppedAfterScroll?.title === "Capture copied" && shotU.width === 200 * scale && near(shotU.center, [0, 0, 220]), `${JSON.stringify(steppedAfterScroll)} ${shotU.width}×${shotU.height} ${JSON.stringify(shotU.center)}`);
  if (!steppedAfterScroll) await ac(`return audit.key(53, "\\u001b").then(() => audit.settle(300));`);


  const full = await ac(`${S} S().activate("c");
    return audit.until(() => S().tabs.c.title === "Tall" && ac.webviews.has("c"), 20000)
      .then(() => audit.settle(800))
      .then(() => ac.webviews.get("c").evaluate("post('result', JSON.stringify([document.documentElement.scrollWidth, document.documentElement.scrollHeight, innerHeight]))"))
      .then((size) => { audit.clear(); return ac.shell.devMenuCommand("captureFullPage", null).then(() => audit.until(() => audit.toast()?.title === "Capture copied", 20000)).then(() => ({ size, toast: audit.toast() })); });`);
  const shotE = readPasteboard();
  const [pageWidth, pageHeight, shownHeight] = full.size ?? [];
  check("Capture Full Page copies the whole page, past the window", full.toast?.title === "Capture copied" && shownHeight < pageHeight && shotE.width === pageWidth * scale && shotE.height === pageHeight * scale, `${shotE.width}×${shotE.height} for a ${pageWidth}×${pageHeight} page in a ${shownHeight} pt window`);
  check("its middle and bottom are the page's (green, blue)", near(shotE.center, [0, 160, 0]) && near(shotE.corner, [0, 0, 220]), `${JSON.stringify(shotE.center)} ${JSON.stringify(shotE.corner)}`);

  const lingering = await ac(`return audit.settle(5500).then(() => audit.toast());`);
  check("the full-page result toast closes by itself", lingering === null, JSON.stringify(lingering));

  const restarted = await ac(`${S} S().activate("c");
    const seen = [];
    const stop = ac.toasts.subscribe((t) => seen.push([performance.now(), t.toasts.w1 ? t.toasts.w1.title : null]));
    return audit.settle(300)
      .then(() => { audit.clear(); return ac.shell.devMenuCommand("captureFullPage", null); })
      .then(() => ac.shell.devMenuCommand("captureFullPage", null))
      .then(() => audit.until(() => audit.toast()?.title === "Capture copied", 20000))
      .then(() => { stop(); const done = seen.findIndex((e) => e[1] === "Capture copied"); const gaps = seen.slice(0, done).filter((e, i, all) => e[1] === null && (all[i + 1] ? all[i + 1][0] : seen[done][0]) - e[0] > 30); return { gaps: gaps.length, titles: seen.map((e) => e[1]) }; });`);
  check("running Capture Full Page again while it works keeps its progress until the result", restarted.gaps === 0 && restarted.titles.includes("Capture copied"), JSON.stringify(restarted));

  const beforeSuperseded = readPasteboard().count;
  const superseded = await ac(`${S} S().activate("c");
    return audit.settle(300)
      .then(() => { audit.clear(); return ac.shell.devMenuCommand("captureFullPage", null); })
      .then(() => ac.shell.devMenuCommand("capture", null))
      .then(() => audit.until(() => audit.toast()?.title === "Capture copied", 20000))
      .then(() => audit.settle(400))
      .then(() => ${dragOn([100, 200], [300, 320])})
      .then(() => audit.toast());`);
  const shotX = readPasteboard();
  check("⇧⌘2 while a full page is coming doesn't start Capture…, and the full page still lands", superseded?.title === "Capture copied" && shotX.count !== beforeSuperseded && shotX.height === pageHeight * scale, `${JSON.stringify(superseded)} ${shotX.width}×${shotX.height}`);

  const orphan = await ac(`${S} S().activate("b");
    return audit.until(() => ac.webviews.has("b"), 10000)
      .then(() => audit.settle(600))
      .then(() => audit.start())
      .then(() => ${dragOn([40, 40], [240, 140])})
      .then(() => { const t = audit.toast(); S().closeTab("b"); return audit.settle(600).then(() => { if (t && t.action) t.action.run(); return audit.until(() => audit.toast()?.title === "Capture saved", 5000); }); })
      .then(() => audit.toast());`);
  check("Save still writes the capture after its tab closes", orphan?.title === "Capture saved", JSON.stringify(orphan));

  const closedDuring = await ac(`${S} S().activate("c");
    return audit.settle(300)
      .then(() => { audit.clear(); return ac.shell.devMenuCommand("captureFullPage", null); })
      .then(() => { S().closeTab("c"); return audit.settle(1500); })
      .then(() => audit.toast());`);
  check("closing the tab during a full page clears its progress", !closedDuring || closedDuring.title !== "Capturing the full page…", JSON.stringify(closedDuring));
} finally {
  await instance.quit();
}
process.exit(results.every(Boolean) ? 0 : 1);
