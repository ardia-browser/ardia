import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const fullScreen = read("../ios/ArdiaWindowFullScreen.mm");
const pkg = JSON.parse(read("../package.json"));

const body = (source, header) => {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? source.length : end);
};

test("the window leaves macOS full screen only from the current Space, which Mission Control and other desktops take away", () => {
  const can = body(fullScreen, "- (BOOL)canLeaveFullScreen {");
  assert.match(can, /if \(!ardia_host::Background\(\)\) return window\.isOnActiveSpace;/);
  assert.match(can, /NSNumber \*acted = objc_getAssociatedObject\(window, kActedOcclusionKey\);\n\s+return !acted \|\| acted\.boolValue;/);
});

test("a page that leaves full screen off the current Space keeps the window full screen instead of starting the exit", () => {
  const sync = body(fullScreen, "- (void)sync {");
  const leaving = sync.slice(sync.indexOf("} else if (toggle == -1) {"));
  const gate = leaving.indexOf("![self canLeaveFullScreen]");
  assert.ok(gate >= 0, "the way out asks first");
  assert.ok(gate < leaving.indexOf("![self pageDrew:_leftTab entering:NO]"), "before it waits for the page to draw");
  const entering = sync.slice(sync.indexOf("if (toggle == 1) {"), sync.indexOf("} else if (toggle == -1) {"));
  assert.doesNotMatch(entering, /canLeaveFullScreen/, "the way in is unchanged");
});

test("the toggle checks again after the page cover, so a swipe into Mission Control meanwhile still holds the exit", () => {
  const toggle = body(fullScreen, "- (void)toggle:(BOOL)entering {");
  assert.match(toggle, /\(entering \? _tab && !_entered : !_tab && _entered && \[self canLeaveFullScreen\]\);/);
  assert.ok(toggle.indexOf("canLeaveFullScreen") < toggle.indexOf("ToggleWindowFullScreen(coreWindow);"));
});

test("a held exit runs once the window is back on the current Space or in sight", () => {
  const init = body(fullScreen, "- (instancetype)initWithCoreWindow:(ArdiaCoreWindow *)coreWindow {");
  assert.match(init, /_spaceObserver = \[NSWorkspace\.sharedWorkspace\.notificationCenter addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification[\s\S]*?usingBlock:\^\(NSNotification \*\) \{ \[weakSelf sync\]; \}\];/);
  assert.match(body(fullScreen, "- (void)dealloc {"), /if \(_spaceObserver\) \[NSWorkspace\.sharedWorkspace\.notificationCenter removeObserver:_spaceObserver\];/);
  const did = body(fullScreen, "- (void)windowDid:(NSNotificationName)name {");
  const retry = did.indexOf("if ([name isEqualToString:NSWindowDidChangeOcclusionStateNotification]) [self sync];");
  assert.ok(retry > did.indexOf("[self updateSeen];"), "after the window's sight is updated");
});

test("the portable suite runs this check", () => {
  assert.match(pkg.scripts["test:portable"], /tests\/fullscreen-exit-active-space-wiring\.test\.mjs/);
});
