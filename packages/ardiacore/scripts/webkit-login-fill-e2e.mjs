#!/usr/bin/env node
// Fills a saved login with quotes, backslashes, </script>, tabs, U+2028 and emoji into a WebKit tab of a hidden
// Ardia instance, the way a user does: a real click on the username field, then Down and Enter in the login list.
// Passes when both fields hold the saved login byte for byte and the page saw input and change events.
//
//   node packages/ardiacore/scripts/webkit-login-fill-e2e.mjs <Ardia.app> <scratch dir> [--metro-port N] [--keep]
//
//   <Ardia.app>    a Debug build (apps/browser/build-*), never an installed app
//   <scratch dir>  data/ is ARDIA_DATA_DIR (wiped first); e2e.log has the detail
//   --metro-port   the Metro serving this tree's JS (default 8081)
//   --keep         leaves the instance running
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { freePort, launch, reporter, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const metroIndex = args.indexOf("--metro-port");
const metroPort = metroIndex >= 0 ? Number(args[metroIndex + 1]) : 8081;
const [appArg, scratchArg] = args.filter((a, i) => !a.startsWith("--") && i !== metroIndex + 1);
if (args.includes("--help") || args.includes("-h") || !appArg || !scratchArg) {
  const lines = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 64);
}

const USERNAME = "o'neil\"\\</script>user";
const PASSWORD = "p'w\"d\\\\</script><script>alert(1)</script>\t\u2028\u2029${x}`é🔑";
const SCRATCH = path.resolve(scratchArg);
const DATA = path.join(SCRATCH, "data");
fs.mkdirSync(SCRATCH, { recursive: true });
const report = reporter(path.join(SCRATCH, "e2e.log"), { name: "webkit login fill" });
const q = JSON.stringify;
const events = `JSON.parse(document.body.dataset.events || "[]")`;

const loginPage = `<!doctype html><title>Login</title>
<form method="post" action="/done"><input id="u" name="user" autocomplete="username" style="position:absolute;left:40px;top:40px;width:300px;height:30px">
<input id="p" type="password" name="pass" autocomplete="current-password" style="position:absolute;left:40px;top:100px;width:300px;height:30px">
<button id="go" style="position:absolute;left:40px;top:160px">Sign in</button></form>
<script>
const note = (event) => (document.body.dataset.events = JSON.stringify([...JSON.parse(document.body.dataset.events || "[]"), event]));
addEventListener("mousedown", (e) => note(["mousedown", e.clientX, e.clientY]), true);
for (const el of document.querySelectorAll("input")) for (const kind of ["input", "change"]) el.addEventListener(kind, () => note([el.id + ":" + kind]));
</script>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url.startsWith("/done") ? "<!doctype html><title>Done</title>signed in" : loginPage);
});
const serverPort = await freePort();
await new Promise((r) => server.listen(serverPort, "127.0.0.1", r));
const base = `http://127.0.0.1:${serverPort}`;

const until = async (what, test, ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
};

let app = null;
try {
  app = await launch(appArg, { data: DATA, fresh: true, onboarded: true, metroPort, startTimeout: 120000 });
  const evalApp = (body) => app.eval(body, { timeout: 20000 });
  const engine = (name, payload) => evalApp(`return ac.engine.call(${q(name)}, ${q(payload)})`);
  const pageValue = (id, expr) => evalApp(`return ac.webviews.get(${q(id)})?.evaluate(${q(`post("result", JSON.stringify(${expr}))`)}) ?? null`);
  const inPage = (id, code) => evalApp(`ac.webviews.get(${q(id)})?.executeJavaScript(${q(code)}); return true`);
  const loadedAs = (id, title) =>
    evalApp(`const s = ac.store.getState(); return s.tabs[${q(id)}]?.title === ${q(title)} && !ac.tabLive.liveOf(${q(id)})?.isLoading ? true : null`);

  let tab = null;
  const opened = await report.check("a WebKit tab opens the sign-in page", async () => {
    await evalApp(`const s = ac.store.getState(); s.updateSettings({ websiteEngines: { ...s.settings.websiteEngines, ${q(base)}: "webkit" } }); return true`);
    const windowId = await evalApp("return ac.store.getState().windowOrder[0]");
    const id = await evalApp(`return ac.store.getState().newTab(${q(windowId)}, { url: ${q(base + "/login")} })`);
    await until("the login page in WebKit", () => loadedAs(id, "Login"), 20000);
    if (await engine("tabs.devBrowserId", { tabId: id }).catch(() => null)) throw new Error("opened in Chromium");
    tab = id;
    return id;
  });
  if (!opened) throw new Error("no WebKit tab");

  await report.check("the hostile login is saved through the save prompt", async () => {
    await inPage(tab, `document.getElementById("u").value = ${q(USERNAME)}; document.getElementById("p").value = ${q(PASSWORD)}; document.querySelector("form").requestSubmit()`);
    await until("the save prompt", () => evalApp(`return ac.pageState.getState().pages[${q(tab)}]?.passwordPrompt?.state === "save" || null`), 25000);
    await evalApp(`return ac.webviews.get(${q(tab)}).resolvePasswordPrompt("save")`);
    return until("the saved login", async () => {
      const list = await engine("passwords.list", { profile: "" }).catch(() => null);
      return list?.passwords?.some((x) => x.username === USERNAME) || null;
    }, 10000);
  });

  await report.check("Down and Enter in the login list fill both fields byte for byte", async () => {
    await evalApp(`ac.store.getState().navigate(${q(tab)}, ${q(base + "/login?fill")}, { userInitiated: true }); return true`);
    await until("the login page again", async () => (await loadedAs(tab, "Login")) && (await pageValue(tab, "location.search")) === "?fill", 20000);
    const windowId = await evalApp("return ac.store.getState().windowOrder[0]");
    const helper = await evalApp(`return ac.store.getState().newTab(${q(windowId)}, { url: ${q(`http://localhost:${serverPort}/done`)} })`);
    const n = await until("the window number", () => engine("tabs.devWindowNumber", { tabId: helper }).catch(() => null), 15000);
    await evalApp(`ac.actions.switchToTab(${q(tab)}); return true`);
    await until("the WebKit tab in front", () => evalApp(`return ac.store.getState().windows[${q(windowId)}]?.activeTabId === ${q(tab)} || null`), 5000).catch(() => null);
    await sleep(500);
    const act = (action) => engine("windows.dev", { window: n, action });
    await act("fakeActiveClicks");
    const press = async (x, y) => {
      await act(`mouse:down:${x},${y}`);
      await sleep(80);
      await act(`mouse:up:${x},${y}`);
    };
    let spot = null;
    for (const [x, y] of [[700, 450], [600, 500], [900, 300], [500, 300]]) {
      const hit = await act(`hit:${x},${y}`);
      if (!spot && /WK|WebView/.test(hit)) spot = [x, y];
    }
    if (!spot) throw new Error("no window point over the page");
    await press(...spot);
    const down = await until("the calibration press", async () => (await pageValue(tab, `${events}.find((e) => e[0] === "mousedown") ?? null`)), 5000);
    const scale = 1 / (await evalApp("return globalThis.expo.modules.ArdiaApp.interfaceScale()"));
    const at = (x, y) => [Math.round(spot[0] + (x - down[1]) * scale), Math.round(spot[1] + (y - down[2]) * scale)];
    await press(...at(190, 55));
    await until("the username field focus", () => pageValue(tab, "document.activeElement?.id === 'u' || null"), 5000);
    await until("the login list", async () => /"NSPanel","visible":true/.test(await act("children")) || null, 5000);
    report.log(`down: ${await act("type:\uF701")}`);
    await sleep(300);
    report.log(`enter: ${await act("type:\r")}`);
    const filled = await until("the filled password", async () => {
      const values = await pageValue(tab, "[document.getElementById('u').value, document.getElementById('p').value]");
      return values?.[1] ? values : null;
    }, 10000);
    if (filled[0] !== USERNAME) throw new Error(`username ${q(filled[0])}`);
    if (filled[1] !== PASSWORD) throw new Error(`password ${q(filled[1])}`);
    const seen = (await pageValue(tab, `${events}.filter((e) => e.length === 1).map((e) => e[0])`)).join(",");
    if (!seen.endsWith("u:input,u:change,p:input,p:change")) throw new Error(`events ${seen}`);
    return { events: seen };
  });
} catch (error) {
  report.log(`stopped: ${error.stack ?? error}`);
} finally {
  server.close();
  if (app && !keep) await app.quit({ graceful: true, timeout: 15000 }).catch(() => app.kill());
}
process.exit(report.summary() ? 0 : 1);
