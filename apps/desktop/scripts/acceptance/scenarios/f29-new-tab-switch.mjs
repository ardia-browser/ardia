import assert from "node:assert/strict";
import { startBrowser } from "../lib/flows.mjs";
import { sessionSeed } from "../lib/seed.mjs";
import { js, pause } from "../lib/util.mjs";

export default {
  id: "F29",
  issue: 2391,
  title: "Leaving New Tab removes its search field and background on the first switched frame",
  deadline: 180000,
  async run(t) {
    const urls = [t.fixtures.url.page(1, "new-tab-switch"), t.fixtures.url.page(2, "new-tab-switch")];
    const { app, shell } = await startBrowser(t, { session: sessionSeed({ windows: [{ id: "main", urls }] }) });
    for (const [index, url] of urls.entries()) {
      await shell.state(`s.activate(${js(`main-tab-${index}`)}); s.setFocusedWindow(windowId); return true;`);
      await app.pageLoaded(url);
    }
    for (const mode of ["page", "commandBar"]) for (const method of ["sidebar", "keyboard"]) {
      await t.check(`${mode} dismisses on ${method} tab switching`, async () => {
        await shell.state(`s.closeTabs(Object.values(s.tabs).filter((tab) => !tab.url).map((tab) => tab.id)); s.activate("main-tab-1"); s.updateSettings({ newTabOpens: ${js(mode)} }); return true;`);
        await shell.command("newTab");
        await shell.waitFor(`!!document.querySelector('input[placeholder="Search or enter address"]')`);
        await pause(450);
        const from = await shell.activeTabId();
        await shell.eval(`(() => {
          const frames = globalThis.newTabSwitchFrames = [];
          const end = performance.now() + 600;
          const sample = () => {
            const s = ardiaLinux.store.getState(), w = s.windows[${js(shell.windowId)}];
            frames.push({ active: w.activeTabIds[w.profileId], lingering: !!document.getElementById("ardia.lingeringPane"), panel: !!s.windowUi[w.id]?.panel.open });
            if (performance.now() < end) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        })()`);
        if (method === "sidebar") await shell.clickText("Acceptance page 1");
        else {
          await shell.key("Tab", { code: "Tab", keyCode: 9, modifiers: 2 });
          await pause(180);
          await shell.key("Control", { code: "ControlLeft", keyCode: 17 });
        }
        await pause(100);
        await t.screenshot(shell, `${mode}-${method}-first-frame`);
        await pause(600);
        const frames = await shell.eval("globalThis.newTabSwitchFrames");
        await t.evidence(`${mode}-${method}-frames`, frames);
        const switched = frames.filter((frame) => frame.active !== from);
        assert.ok(switched.length > 0, "the input must actually switch tabs");
        assert.ok(switched.every((frame) => !frame.lingering && !frame.panel), "the first switched frame must have no New Tab overlay");
        await t.screenshot(shell, `${mode}-${method}`);
        return { switchedFrames: switched.length };
      });
    }
  },
};
