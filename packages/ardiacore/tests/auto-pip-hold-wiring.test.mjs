import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const internal = read("../ios/ArdiaWebViewInternal.h");
const painting = read("../ios/ArdiaWebView+Painting.mm");
const pip = read("../ios/ArdiaWebView+PictureInPicture.mm");
const fullScreen = read("../ios/ArdiaWindowFullScreen.mm");
const hostHeader = read("../ios/ArdiaChromeWindowHost.h");
const hostPip = read("../ios/ArdiaPictureInPicture.mm");
const webKitSight = read("../ios/WebKitTab+AutoPictureInPicture.swift");
const pkg = JSON.parse(read("../package.json"));

const body = (source, header) => {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? source.length : end);
};

test("each Chromium view keeps the hold beside its other auto Picture in Picture reports", () => {
  assert.match(internal, /#include "ArdiaAutoPictureInPictureHold\.h"/);
  assert.match(internal, /BOOL playedForAutoPictureInPicture\{\};\n\s+ardia_auto_pip::Hold autoPictureInPictureHold;/);
});

test("a held tab tells Chrome nothing, so a glimpse of its window can't make the hidden edge that reopens it", () => {
  const noteShown = body(painting, "+ (void)noteShown:(ArdiaCoreTab *)tab {");
  const gate = noteShown.indexOf("if (view && !view->_reports.autoPictureInPictureHold.tellsChrome(view.userBackOnTab)) return;");
  assert.ok(gate >= 0, "noteShown asks the hold first");
  assert.ok(gate > noteShown.indexOf("[changes setObject:@(change) forKey:tab];"), "a held tab still cancels a hide waiting to be told");
  assert.ok(gate < noteShown.indexOf("noteShownByHost:"), "the hold is asked before Chrome is told anything");
  assert.match(noteShown, /if \(!now\.seenByUser && !\(now && now->_reports\.autoPictureInPictureHold\.held\)\) \[tab noteShownByHost:NO\];/);
});

test("the person is back on a tab when they see it with Ardia in front for more than a Picture in Picture window", () => {
  assert.match(painting, /- \(BOOL\)userBackOnTab \{\n\s+return self\.seenByUser && !ArdiaChromeWindowHost\.userInAnotherApp;\n\}/);
  assert.match(hostHeader, /\+ \(BOOL\)userInAnotherApp;/);
  assert.match(body(hostPip, "+ (BOOL)userInAnotherApp {"), /return !NSApp\.isActive \|\| ActiveOnlyForPictureInPicture\(\);/);
  assert.match(fullScreen, /BOOL UserInAnotherApp\(\) \{ return ArdiaChromeWindowHost\.userInAnotherApp; \}/);
});

test("coming back to Ardia tells each tab of the window even when what the window shows didn't change", () => {
  const update = body(fullScreen, "- (void)updateSeen {");
  assert.match(update, /const BOOL inAnotherApp = UserInAnotherApp\(\);/);
  assert.match(update, /if \(seen == _seen && inAnotherApp == _inAnotherApp && !overruleChanged && !_leftApp\) return;\n\s+_seen = seen;\n\s+_inAnotherApp = inAnotherApp;/);
});

test("a Picture in Picture that ends while its tab is out of sight holds the tab, unless Ardia asked for the end", () => {
  const change = body(pip, "- (void)tab:(ArdiaCoreTab *)tab didChangePictureInPicture:");
  const hold = change.indexOf('if (!active && _reports.inPictureInPicture) [self holdAutoPictureInPictureAfterEnd:[state[@"closedBy"] isEqual:@"app"]];');
  assert.ok(hold >= 0, "the end is offered to the hold");
  assert.ok(hold < change.indexOf("_reports.inPictureInPicture = active;"), "before the report forgets the window was open");
  assert.ok(hold < change.indexOf("if (!active && !_reports.inPictureInPicture) return;"), "for a document window too");
  const ended = body(pip, "- (void)holdAutoPictureInPictureAfterEnd:(BOOL)appAsked {");
  assert.match(ended, /if \(!_reports\.autoPictureInPictureHold\.ended\(appAsked, self\.seenByUser\)\) return;/);
  assert.match(ended, /\[self emit:@"autoPictureInPictureKept" payload:\[ArdiaConsentStamp\.begin onto:@\{@"reason" : @"closedWhileAway"\}\]\];/);
  assert.match(ended, /dispatch_async\(dispatch_get_main_queue\(\), \^\{ \[weakSelf autoPictureInPictureInputsChanged\]; \}\);/);
});

test("a held tab plays for nobody, so the window server isn't polled and no hold is reported for it, until the person is back", () => {
  assert.match(body(pip, "- (BOOL)playsForAutoPictureInPicture {"), /if \(_reports\.autoPictureInPictureHold\.held\) return NO;/);
  const sight = body(painting, "- (void)userSightChanged {");
  const held = sight.indexOf("const bool wasHeld = _reports.autoPictureInPictureHold.held;");
  assert.ok(held >= 0 && held < sight.indexOf("[ArdiaWebView noteShown:_tab]"));
  assert.match(sight, /if \(wasHeld && !_reports\.autoPictureInPictureHold\.held\) \{\n\s+\[self notePictureInPictureSight:@"hold released"\];\n\s+\[self autoPictureInPictureInputsChanged\];\n\s+\}/);
});

test("WebKit tabs hold the same way and say so once", () => {
  assert.match(webKitSight, /autoPictureInPictureRule\.sight\(seen, userIn: !ArdiaChromeWindowHost\.userInAnotherApp\(\), inline: !pageHeldInFullscreen, enabled: autoPictureInPicture, playing: playsMedia\)/);
  assert.match(webKitSight, /var playsForAutoPictureInPicture: Bool \{ autoPictureInPicture && playsMedia && !autoPictureInPictureRule\.heldUntilBack \}/);
  assert.match(webKitSight, /let wasHeld = autoPictureInPictureRule\.heldUntilBack\n[\s\S]*\n\s+if wasHeld && !autoPictureInPictureRule\.heldUntilBack \{ autoPictureInPictureInputsChanged\(\) \}/);
  assert.match(webKitSight, /guard let \(active, reported\) = autoPictureInPictureRule\.report\(data, from: frame\) else \{ return \}\n\s+if reported\.closeAgain \{ setPictureInPicture\(false\) \{ _ in \} \}\n\s+if reported\.heldNow \{\n\s+emit\("autoPictureInPictureKept", ArdiaConsentStamp\.begin\(\)\.onto\(\["reason": "closedWhileAway"\]\)\)\n\s+autoPictureInPictureInputsChanged\(\)\n\s+\}/);
});

test("the hold's own test runs with the package's tests", () => {
  assert.match(pkg.scripts.test, /tests\/auto-pip-hold\.test\.cc -o "\$\{TMPDIR:-\/tmp\}\/ardiacore-auto-pip-hold-test" && "\$\{TMPDIR:-\/tmp\}\/ardiacore-auto-pip-hold-test"/);
  assert.match(pkg.scripts["test:portable"], /tests\/auto-pip-hold-wiring\.test\.mjs/);
});
