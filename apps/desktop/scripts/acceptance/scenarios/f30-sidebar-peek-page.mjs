import assert from "node:assert/strict";
import { startBrowser } from "../lib/flows.mjs";
import { sessionSeed } from "../lib/seed.mjs";
import { js, pause } from "../lib/util.mjs";

const EDGE_PATHS = { left: [600, 300, 100, 40, 10, 2], right: [300, 600, 800, 860, 890, 898] };
const PAGE_SHOWN = "((status) => !!status && status.acked === status.sequence && (status.sent?.pages.length ?? 0) > 0)(ardiaLinux.inputRegions()?.status())";
const CASES = [
  { side: "left", addressBar: "toolbar" },
  { side: "right", addressBar: "toolbar" },
  { side: "left", addressBar: "sidebar" },
];

export default {
  id: "F30",
  issue: 2736,
  title: "Peeking the hidden sidebar keeps the page drawn under it",
  deadline: 180000,
  async run(t) {
    const url = t.fixtures.url.page(1, "sidebar-peek");
    const { app, shell } = await startBrowser(t, { session: sessionSeed({ windows: [{ id: "main", urls: [url] }] }) });
    await shell.state(`s.activate("main-tab-0"); s.setFocusedWindow(windowId); return true;`);
    await app.pageLoaded(url);
    await shell.command("toggleSidebar");
    await shell.waitState(`return (s.windows[windowId]?.autoHideTabs ?? s.settings.autoHideTabs) === true;`, { label: "Auto-hide tabs on" });
    for (const { side, addressBar } of CASES) {
      await t.check(`the page is never hidden while a ${side} sidebar with the address bar in the ${addressBar} peeks out and slides away`, async () => {
        await shell.state(`s.updateSettings({ sidebarSide: ${js(side)}, addressBar: ${js(addressBar)} }); return true;`);
        await shell.waitState(`return s.settings.sidebarSide === ${js(side)} && s.settings.addressBar === ${js(addressBar)};`, { label: `sidebar on the ${side}, address bar in the ${addressBar}` });
        await pause(1200);
        const width = await shell.eval("window.innerWidth");
        const path = side === "left" ? EDGE_PATHS.left : EDGE_PATHS.right.map((x) => width - (900 - x));
        await shell.waitFor(PAGE_SHOWN, { label: "the page shown before the peek" });
        await shell.eval(`(() => {
          const record = globalThis.sidebarPeekRecord = { sent: [], regionRequests: 0, peekFrames: 0, opens: 0, closes: 0, handleFrames: 0, handleUncovered: 0, stopped: false };
          const send = chrome.send.bind(chrome);
          chrome.send = (name, params) => {
            const call = name === "ardiaRequest" ? params?.[2] : undefined;
            if (call?.method === "tab.viewport") record.sent.push(call.args.visible);
            if (call?.method === "shell.inputRegions" && Array.isArray(call.args?.overlays)) record.regionRequests++;
            return send(name, params);
          };
          const handleBeside = (mark) => {
            for (let node = mark.parentElement; node; node = node.parentElement) {
              const handle = [...node.children].find((child) => getComputedStyle(child).cursor === "col-resize");
              if (handle) return handle;
            }
            return null;
          };
          let shown = false;
          const sample = () => {
            if (record.stopped) return void (chrome.send = send);
            const mark = document.querySelector('[data-testid="ardia-sidebar-peek"]');
            if (mark && !shown) record.opens++;
            if (!mark && shown) record.closes++;
            shown = !!mark;
            if (mark) {
              record.peekFrames++;
              const handle = handleBeside(mark);
              if (handle) {
                record.handleFrames++;
                const region = mark.getBoundingClientRect();
                const grip = handle.getBoundingClientRect();
                if (grip.left < region.left - 0.5 || grip.right > region.right + 0.5 || grip.top < region.top - 0.5 || grip.bottom > region.bottom + 0.5) record.handleUncovered++;
              }
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
          return true;
        })()`);
        for (let round = 0; round < 2; round++) {
          for (const x of path) {
            await shell.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 400 });
            await pause(30);
          }
          await pause(900);
          await shell.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(width / 2), y: 400 });
          await pause(900);
        }
        const record = await shell.eval("(() => { const { stopped, ...r } = globalThis.sidebarPeekRecord; globalThis.sidebarPeekRecord.stopped = true; return r; })()");
        await t.evidence(`viewports-${side}-${addressBar}`, record);
        await t.screenshot(shell, `peek-${side}-${addressBar}`);
        assert.ok(record.opens >= 2 && record.closes >= 2, `the sidebar must peek out and slide away twice: ${js(record)}`);
        assert.ok(record.regionRequests > 0, "the shell's host requests must be read by the recorder");
        assert.equal(record.handleFrames, record.peekFrames, "the resize handle must be found beside the peek on every frame");
        assert.equal(record.handleUncovered, 0, "the peek's input region must cover the resize handle on every frame");
        assert.ok(!record.sent.includes(false), `the page was hidden during the peek: ${js(record.sent)}`);
        await shell.waitFor(PAGE_SHOWN, { timeout: 5000, label: "the page still shown after the peeks" });
        return { viewports: record.sent.length, peekFrames: record.peekFrames };
      });
    }
  },
};
