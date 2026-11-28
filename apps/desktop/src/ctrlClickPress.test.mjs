import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BUILDS = ["react-native-web/dist/cjs/modules/useResponderEvents/utils.js", "react-native-web/dist/modules/useResponderEvents/utils.js"];

function pressRuleOn(platform) {
  Object.defineProperty(globalThis, "navigator", { value: { platform, userAgent: "" }, configurable: true });
  const path = require.resolve(BUILDS[0]);
  delete require.cache[path];
  return require(path).isPrimaryPointerDown;
}

const pressRule = (path) => readFileSync(require.resolve(path), "utf8").match(/var ctrlClickIsSecondary[^\n]*|var noModifiers[^\n]*/g);

const mouse = (type, mods = {}) => ({ type, button: 0, buttons: 1, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...mods });

test("on Linux and Windows a Ctrl-click starts a press, so a tab switcher card held open with Ctrl+Tab takes the click (#4432)", () => {
  for (const platform of ["Linux x86_64", "Win32"]) {
    const pressStarts = pressRuleOn(platform);
    assert.equal(pressStarts(mouse("mousedown", { ctrlKey: true })), true, platform);
    assert.equal(pressStarts(mouse("mousemove", { ctrlKey: true })), true, `${platform}: a Ctrl-drag keeps its press`);
    assert.equal(pressStarts(mouse("mousedown")), true, platform);
    assert.equal(pressStarts(mouse("mousedown", { altKey: true })), false, `${platform}: Alt-clicks stay the window manager's`);
    assert.equal(pressStarts(mouse("mousedown", { ctrlKey: true, button: 2, buttons: 2 })), false, `${platform}: a right click is never a press`);
  }
});

test("on a Mac a Ctrl-click is still a right click and starts no press", () => {
  for (const platform of ["MacIntel", "iPad"]) {
    const pressStarts = pressRuleOn(platform);
    assert.equal(pressStarts(mouse("mousedown", { ctrlKey: true })), false, platform);
    assert.equal(pressStarts(mouse("mousedown")), true, platform);
  }
});

test("Vite's ES module build of React Native Web carries the same press rule as the CommonJS build the test loads", () => {
  assert.deepEqual(pressRule(BUILDS[1]), pressRule(BUILDS[0]));
  assert.equal(pressRule(BUILDS[1]).length, 2);
});

test("a desktop press starts on mousedown as a Mac press does, so a quick Ctrl-click picks its card before the mouseup that closes the switcher", () => {
  const webDefault = readFileSync(require.resolve("react-native-web/dist/modules/usePressEvents/PressResponder.js"), "utf8");
  assert.match(webDefault, /var DEFAULT_PRESS_DELAY_MS = 50;/, "React Native Web still holds a mouse press 50 ms before onPressIn");
  const shim = readFileSync(new URL("./shims/web/motion/macView.tsx", import.meta.url), "utf8");
  assert.match(shim, /<BasePressable\s+delayPressIn=\{0\}\s+\{\.\.\.strip\(props\)\}/);
});
