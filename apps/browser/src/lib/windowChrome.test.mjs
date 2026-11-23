import assert from "node:assert/strict";
import { test } from "node:test";
const { WINDOW_CHROME, captionRoom, captionClearTop } = await import("./windowChrome.ts");
const windows = (await import("./platformChrome.windows.ts")).WINDOW_CHROME;

test("the Mac reserves the traffic lights' 78 points at the leading top and nothing at the trailing top", () => {
  assert.deepEqual(WINDOW_CHROME, { leadingWidth: 78, trailingWidth: 0, titleBarHeight: 0, leadingButtons: [], trailingButtons: [] });
  for (const [fromRight, fromTop] of [[0, 0], [9, 9], [0, 40], [200, 0]]) assert.equal(captionRoom(fromRight, fromTop), 0);
  for (const row of [0, 28, 41]) assert.equal(captionClearTop(9, row, 9), 9);
});

test("Windows reserves the caption buttons' 171 by 32 at the trailing top and nothing at the leading top", () => {
  assert.deepEqual(windows, { leadingWidth: 0, trailingWidth: 171, titleBarHeight: 32, leadingButtons: [], trailingButtons: ["menu", "minimize", "maximize", "close"] });
  assert.equal(captionRoom(0, 0, windows), 171);
  assert.equal(captionRoom(9, 9, windows), 162);
  assert.equal(captionRoom(9, 31, windows), 162);
  assert.equal(captionRoom(9, 32, windows), 0);
  assert.equal(captionRoom(9, 42, windows), 0);
  assert.equal(captionRoom(171, 0, windows), 0);
  assert.equal(captionRoom(190, 0, windows), 0);
});

test("on Windows a card whose top row is shorter than the caption buttons starts below them", () => {
  assert.equal(captionClearTop(9, 41, 9, windows), 9);
  assert.equal(captionClearTop(9, 28, 9, windows), 9);
  assert.equal(captionClearTop(9, 16, 9, windows), 16);
  assert.equal(captionClearTop(9, 0, 9, windows), 32);
  assert.equal(captionClearTop(9, 0, 190, windows), 9);
});

test("Linux starts with the Windows build's buttons at the trailing top and switches to the traffic lights at the leading top and back", async () => {
  const linux = await import("./platformChrome.desktop.ts");
  assert.deepEqual(linux.WINDOW_BUTTON_STYLES, ["native", "trafficLights", "hidden"]);
  assert.deepEqual(linux.WINDOW_CHROME, windows);
  assert.notEqual(linux.WINDOW_CHROME, windows, "switching on Linux never changes the Windows build's chrome");
  assert.equal(linux.applyWindowButtonStyle("native"), false);
  assert.equal(linux.applyWindowButtonStyle("trafficLights"), true);
  assert.deepEqual(linux.WINDOW_CHROME, WINDOW_CHROME, "the traffic lights reserve what the Mac's do");
  assert.equal(captionRoom(0, 0, linux.WINDOW_CHROME), 0);
  assert.equal(linux.applyWindowButtonStyle("trafficLights"), false);
  assert.equal(linux.applyWindowButtonStyle("native"), true);
  assert.deepEqual(linux.WINDOW_CHROME, windows);
  assert.deepEqual(windows, { leadingWidth: 0, trailingWidth: 171, titleBarHeight: 32, leadingButtons: [], trailingButtons: ["menu", "minimize", "maximize", "close"] });
});

test("Linux with the window buttons hidden draws no caption buttons and keeps no room for them at either top corner", async () => {
  const linux = await import("./platformChrome.desktop.ts");
  const { windowControlsDrawn } = await import("./windowChrome.ts");
  for (const from of ["native", "trafficLights"]) {
    linux.applyWindowButtonStyle(from);
    assert.equal(linux.applyWindowButtonStyle("hidden"), true, from);
    assert.deepEqual(linux.WINDOW_CHROME, { leadingWidth: 0, trailingWidth: 0, titleBarHeight: 0, leadingButtons: [], trailingButtons: [] }, from);
    assert.equal(windowControlsDrawn(linux.WINDOW_CHROME), false, from);
    assert.equal(captionRoom(0, 0, linux.WINDOW_CHROME), 0, from);
    assert.equal(captionClearTop(9, 0, 9, linux.WINDOW_CHROME), 9, from);
    assert.equal(linux.applyWindowButtonStyle("hidden"), false, from);
  }
  assert.equal(linux.applyWindowButtonStyle("native"), true);
  assert.deepEqual(linux.WINDOW_CHROME, windows);
});

test("the Mac, Windows and the web demo offer no choice of window buttons", async () => {
  const mac = await import("./platformChrome.ts");
  const win = await import("./platformChrome.windows.ts");
  const web = await import("./platformChrome.web.ts");
  for (const platform of [mac, win, web]) {
    assert.deepEqual(platform.WINDOW_BUTTON_STYLES, []);
    assert.equal(platform.applyWindowButtonStyle("trafficLights"), false);
    assert.equal(platform.applyWindowButtonStyle("native"), false);
  }
  assert.deepEqual(mac.WINDOW_CHROME, { leadingWidth: 78, trailingWidth: 0, titleBarHeight: 0, leadingButtons: [], trailingButtons: [] });
  assert.deepEqual(win.WINDOW_CHROME, { leadingWidth: 0, trailingWidth: 171, titleBarHeight: 32, leadingButtons: [], trailingButtons: ["menu", "minimize", "maximize", "close"] });
  assert.deepEqual(web.WINDOW_CHROME, mac.WINDOW_CHROME);
});

test("Linux's native buttons take the desktop's layout: room at each top corner for the buttons drawn there, the default matching Windows", async () => {
  const linux = await import("./platformChrome.desktop.ts");
  const { parseButtonLayout } = await import("./windowButtonLayout.ts");
  const { windowControlsDrawn } = await import("./windowChrome.ts");
  const chrome = (raw) => linux.nativeButtonsChrome(parseButtonLayout(raw));
  assert.deepEqual(chrome(":minimize,maximize,close"), windows);
  assert.deepEqual(chrome(null), windows, "an engine that can't tell keeps today's buttons");
  assert.deepEqual(chrome("appmenu:close"), { leadingWidth: 0, trailingWidth: 105, titleBarHeight: 32, leadingButtons: [], trailingButtons: ["menu", "close"] });
  assert.deepEqual(chrome("menu:close"), chrome("appmenu:close"), "Omarchy's window menu token keeps the … at the right too");
  assert.deepEqual(chrome("close,minimize,maximize:"), { leadingWidth: 108, trailingWidth: 72, titleBarHeight: 32, leadingButtons: ["close", "minimize", "maximize"], trailingButtons: ["menu"] });
  assert.deepEqual(chrome("close:maximize"), { leadingWidth: 42, trailingWidth: 105, titleBarHeight: 32, leadingButtons: ["close"], trailingButtons: ["menu", "maximize"] });
  assert.equal(windowControlsDrawn(chrome("close,minimize,maximize:")), true);
  assert.equal(captionRoom(0, 0, chrome("close,minimize,maximize:")), 72, "with the buttons all at the left the right keeps room for the … alone");
  assert.equal(linux.applyWindowButtonStyle("native", parseButtonLayout("appmenu:close")), true);
  assert.deepEqual(linux.WINDOW_CHROME, chrome("appmenu:close"));
  assert.equal(linux.applyWindowButtonStyle("native", parseButtonLayout("appmenu:close")), false, "the same layout again changes nothing");
  assert.equal(linux.applyWindowButtonStyle("trafficLights", parseButtonLayout("appmenu:close")), true);
  assert.deepEqual(linux.WINDOW_CHROME, linux.TRAFFIC_LIGHTS_CHROME, "the traffic lights ignore the desktop's layout");
  assert.equal(linux.applyWindowButtonStyle("hidden", parseButtonLayout("close:maximize")), true);
  assert.deepEqual(linux.WINDOW_CHROME, linux.HIDDEN_BUTTONS_CHROME, "so does Hidden");
  assert.equal(linux.applyWindowButtonStyle("native"), true);
  assert.deepEqual(linux.WINDOW_CHROME, windows);
});

test("only the traffic lights count as traffic lights: the onboarding previews draw Mac dots for them, not for native buttons at the left", async () => {
  const linux = await import("./platformChrome.desktop.ts");
  const { parseButtonLayout } = await import("./windowButtonLayout.ts");
  const { trafficLightsDrawn } = await import("./windowChrome.ts");
  const left = linux.nativeButtonsChrome(parseButtonLayout("close,minimize,maximize:"));
  assert.ok(left.leadingWidth > 0, "native buttons at the left keep room at the leading top, as the lights do");
  assert.equal(trafficLightsDrawn(left), false);
  assert.equal(trafficLightsDrawn(WINDOW_CHROME), true, "the Mac");
  assert.equal(trafficLightsDrawn(linux.TRAFFIC_LIGHTS_CHROME), true);
  assert.equal(trafficLightsDrawn(windows), false);
  assert.equal(trafficLightsDrawn(linux.HIDDEN_BUTTONS_CHROME), false);
  const { readFileSync } = await import("node:fs");
  for (const file of ["../components/onboarding/previews/Kit.tsx", "../components/onboarding/PinnedTabsStep.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /trafficLightsDrawn\(\)/, file);
    assert.doesNotMatch(source, /WINDOW_CHROME\.leadingWidth/, file);
  }
});
