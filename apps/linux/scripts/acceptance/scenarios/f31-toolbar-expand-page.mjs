import assert from "node:assert/strict";
import { startBrowser } from "../lib/flows.mjs";
import { sessionSeed } from "../lib/seed.mjs";
import { js, pause } from "../lib/util.mjs";

const TAB = "main-tab-0";
const PAGE_SHOWN = "((status) => !!status && status.acked === status.sequence && (status.sent?.pages.length ?? 0) > 0)(ardiaLinux.inputRegions()?.status())";
const REGION = '[data-testid="ardia-auto-hide-toolbar"]';
const SETTLED_OPEN_MS = 150;
const CUT_SHORT = "a peek scrolled open and cut short";
const TRIGGERS = { hover: ["peek"], scroll: ["shown"], click: ["shown"], [CUT_SHORT]: ["peek", "shown"] };

export default {
  id: "F31",
  issue: 3285,
  title: "Opening and folding the hidden toolbar keeps the page drawn under it",
  deadline: 180000,
  async run(t) {
    const url = t.fixtures.url.page(1, "toolbar-expand");
    const { app, shell } = await startBrowser(t, { session: sessionSeed({ windows: [{ id: "main", urls: [url] }] }) });
    await shell.state(`s.activate(${js(TAB)}); s.setFocusedWindow(windowId); s.updateSettings({ hideToolbarWhileScrolling: true }); return true;`);
    const pageTarget = await app.pageLoaded(url);
    const pageSession = await app.connect(pageTarget);
    const hasViewportClip = await shell.eval(`window.__ardiaHost?.bootstrap?.capabilities?.includes("tab.viewportClip") === true`);
    await shell.waitState(`return s.settings.hideToolbarWhileScrolling === true;`, { label: "Hide toolbar while scrolling on" });
    const reveal = () => shell.eval(`(() => { const t = ardiaLinux.toolbar; const { [${js(TAB)}]: _, ...rest } = t.getState().scrolledDown; t.setState({ scrolledDown: rest }); return true; })()`);
    const scrollDown = () => shell.eval(`(() => { const t = ardiaLinux.toolbar; t.setState({ scrolledDown: { ...t.getState().scrolledDown, ${js(TAB)}: true }, peek: {} }); return true; })()`);
    const collapse = async () => {
      await scrollDown();
      await pause(900);
      await shell.waitFor(PAGE_SHOWN, { label: "the page shown under the collapsed toolbar" });
    };
    const strip = async () => {
      const rect = await shell.eval(`(() => { const r = document.querySelector(${js(REGION)})?.getBoundingClientRect(); return r && { x: r.left + r.width / 2, y: r.top + 10 }; })()`);
      assert.ok(rect, "the auto-hide toolbar must be on screen");
      return { x: Math.round(rect.x), y: Math.round(rect.y) };
    };
    const middle = async () => {
      const [width, height] = await shell.eval("[window.innerWidth, window.innerHeight]");
      return { x: Math.round(width / 2), y: Math.round(height / 2) };
    };
    const move = (point) => shell.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    const expand = {
      async hover() {
        await move(await strip());
        await pause(900);
      },
      async scroll() {
        await reveal();
        await pause(900);
      },
      async [CUT_SHORT]() {
        await move(await strip());
        await pause(900);
        await reveal();
        await pause(0);
        await scrollDown();
        await move(await middle());
        await pause(900);
      },
      async click() {
        const point = await strip();
        await shell.session.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
        await shell.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
        await pause(900);
      },
    };
    for (const [trigger, opened] of Object.entries(TRIGGERS)) {
      await t.check(`the page is never hidden while the hidden toolbar opens by ${trigger} and folds away`, async () => {
        await move(await middle());
        await collapse();
        await pageSession.send("Runtime.evaluate", {
          expression: `(() => {
            if (!window.__toolbarResizeInstalled) {
              window.__toolbarResizeInstalled = true;
              window.__toolbarResizes = [];
              window.addEventListener("resize", () => window.__toolbarResizes.push(window.innerHeight));
            }
            window.__toolbarResizes.length = 0;
          })()`,
        });
        await shell.eval(`(() => {
          const slot = document.querySelector("[data-ardia-native-tab]");
          let cardBottom = null;
          for (let parent = slot?.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (style.overflowY !== "visible") { cardBottom = parent.getBoundingClientRect().bottom; break; }
          }
          const record = globalThis.toolbarExpandRecord = { sent: [], bottoms: [], radiiChecked: 0, radiiLost: 0, contentClips: 0, cardBottom, regionRequests: 0, modes: [], shownFor: [], stopped: false };
          const send = chrome.send.bind(chrome);
          chrome.send = (name, params) => {
            const call = name === "ardiaRequest" ? params?.[2] : undefined;
            if (call?.method === "tab.viewport") {
              record.sent.push(call.args.visible);
              if (call.args.visible && call.args.rect) {
                record.bottoms.push(call.args.rect.y + call.args.rect.height);
                if (call.args.radii) {
                  record.radiiChecked++;
                  if (call.args.radii.lowerLeft <= 0 || call.args.radii.lowerRight <= 0) record.radiiLost++;
                }
                if (call.args.contentRect && call.args.contentRect.height > call.args.rect.height) record.contentClips++;
              }
            }
            if (call?.method === "shell.inputRegions" && Array.isArray(call.args?.overlays)) record.regionRequests++;
            return send(name, params);
          };
          const modeOf = (t) => (!t.scrolledDown[${js(TAB)}] ? "shown" : t.peek[${js(TAB)}] ? "peek" : "collapsed");
          const unsubscribe = ardiaLinux.toolbar.subscribe((t) => {
            if (record.stopped) return void (unsubscribe(), (chrome.send = send));
            const mode = modeOf(t);
            if (record.modes.at(-1) === mode) return;
            if (record.modes.at(-1) === "shown") record.shownFor.push(performance.now() - record.shownAt);
            if (mode === "shown") record.shownAt = performance.now();
            record.modes.push(mode);
          });
          record.modes.push(modeOf(ardiaLinux.toolbar.getState()));
          return true;
        })()`);
        for (let round = 0; round < 2; round++) {
          await expand[trigger]();
          await move(await middle());
          await collapse();
        }
        const record = await shell.eval("(() => { const { stopped, ...r } = globalThis.toolbarExpandRecord; globalThis.toolbarExpandRecord.stopped = true; ardiaLinux.toolbar.setState({}); return r; })()");
        const pageResizes = (await pageSession.send("Runtime.evaluate", { expression: "window.__toolbarResizes?.slice()", returnByValue: true })).result?.value;
        record.pageResizes = pageResizes;
        await t.evidence(`viewports-${trigger}`, record);
        await t.screenshot(shell, `expanded-${trigger}`);
        assert.ok(Array.isArray(pageResizes), `page resize recorder must report an array: ${js(pageResizes)}`);
        assert.deepEqual(record.modes.filter((mode) => mode !== "collapsed"), [...opened, ...opened], `the toolbar must open as ${opened.join(" then ")} twice: ${js(record.modes)}`);
        if (trigger === CUT_SHORT) assert.ok(record.shownFor.every((ms) => ms < SETTLED_OPEN_MS), `the opening must be cut short before it settles: ${js(record.shownFor)}`);
        if (opened.join() === "shown") {
          assert.ok(record.sent.length > 0, "the page moving down must reach the recorder as viewport requests");
          assert.ok(record.radiiChecked > 0, "viewport requests during toolbar motion must carry card corner radii");
          if (hasViewportClip) {
            assert.ok(record.contentClips > 0, "the shell must send contentRect while the page is clipped during the glide");
            assert.ok(pageResizes.length <= 4, `two expand-and-collapse rounds must not resize the page per frame: ${js(pageResizes)}`);
          }
        }
        assert.notEqual(record.cardBottom, null, "the clipping page card must be measurable on screen");
        assert.ok(record.bottoms.every((bottom) => bottom <= record.cardBottom + 0.5), `the page protruded past the card bottom (${record.cardBottom}): ${js(record.bottoms)}`);
        assert.equal(record.radiiLost, 0, "the card's bottom corner radii must stay intact while the toolbar moves");
        assert.ok(record.regionRequests > 0, "the shell's host requests must be read by the recorder");
        assert.ok(!record.sent.includes(false), `the page was hidden while the toolbar opened or folded: ${js(record.sent)}`);
        await shell.waitFor(PAGE_SHOWN, { timeout: 5000, label: "the page still shown after the expansions" });
        return { viewports: record.sent.length, contentClips: record.contentClips, pageResizes: pageResizes.length, modes: record.modes };
      });
    }
  },
};
