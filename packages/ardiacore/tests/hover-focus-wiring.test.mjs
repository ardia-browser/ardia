import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const sources = [
  "../ios/ArdiaWebView+Painting.mm",
  "../ios/ArdiaWebView+Focus.mm",
  "../ios/ArdiaWebView+StandIn.mm",
  "../ios/ArdiaHoverProbe.mm",
  "../ios/ArdiaHoverProbe+Refusal.mm",
  "../ios/ArdiaHoverProbe+Cover.mm",
  "../ios/ArdiaHoverProbe+Episode.mm",
  "../ios/ArdiaHoverProbeInternal.h",
  "../ios/ArdiaHoverProbe+Dev.mm",
  "../../shell/ios/FocusHandoff.swift",
  "../../shell/ios/QuitFlow.swift",
  "../../shell/ios/UpdaterCore/HoverLossQuitCommit.swift",
  "../../../apps/browser/src/state/telemetry/hoverLost.ts",
];
const read = (name) => (existsSync(path(name)) ? readFileSync(path(name), "utf8") : "");
const painting = read("../ios/ArdiaWebView+Painting.mm");
const focus = read("../ios/ArdiaWebView+Focus.mm");
const standIn = read("../ios/ArdiaWebView+StandIn.mm");
const probe = read("../ios/ArdiaHoverProbe.mm");
const probeRefusal = read("../ios/ArdiaHoverProbe+Refusal.mm");
const probeInternal = read("../ios/ArdiaHoverProbeInternal.h");
const probeDev = read("../ios/ArdiaHoverProbe+Dev.mm");
const handoff = read("../../shell/ios/FocusHandoff.swift");
const probeCover = read("../ios/ArdiaHoverProbe+Cover.mm");
const probeEpisode = read("../ios/ArdiaHoverProbe+Episode.mm");
const quitFlow = read("../../shell/ios/QuitFlow.swift");
const quitCommit = read("../../shell/ios/UpdaterCore/HoverLossQuitCommit.swift");
const hoverLostJs = read("../../../apps/browser/src/state/telemetry/hoverLost.ts");

const body = (source, header, closer = "\n}\n") => {
  const start = source.indexOf(header);
  if (start < 0) return "";
  const end = source.indexOf(closer, start);
  return source.slice(start, end < 0 ? source.length : end);
};

test("every source the checks read exists", () => {
  const missing = sources.filter((name) => !existsSync(path(name)));
  assert.deepEqual(missing, []);
});

test("applyPainting takes focus from a lingering pane only after it unhides the page, so the page can take the focus back", () => {
  const paint = body(painting, "- (void)applyPainting {");
  const unhidden = paint.indexOf("sub.hidden = !shown;");
  const committed = paint.indexOf("[CATransaction commit];");
  const taken = paint.indexOf("[self takeFocusFromLingeringPane]");
  assert.ok(unhidden > 0 && committed > unhidden && taken > 0, "applyPainting unhides the page and takes focus from the lingering pane");
  assert.ok(taken > committed, "takeFocusFromLingeringPane runs before the page is unhidden, so focusPage is skipped for a hidden page");
});

test("taking focus from a lingering pane gives it to the page when the page is visible, selected and shown", () => {
  const take = body(painting, "- (void)takeFocusFromLingeringPane {");
  assert.match(take, /if \(\[window makeFirstResponder:nil\]\) \[self focusAfterLingeringPane\];/);
  const after = body(focus, "- (void)focusAfterLingeringPane {");
  assert.match(after, /if \(!window \|\| !_visible \|\| !_selected \|\| _standalone \|\| !page \|\| page\.superview != self \|\| page\.isHiddenOrHasHiddenAncestor \|\| \[ArdiaWebView onScreenAheadIn:window\]\) return;/);
  assert.match(after, /\[self focusPage\];/);
});

test("taking focus from a lingering pane gives it back to the tab's remembered DevTools field", () => {
  const after = body(focus, "- (void)focusAfterLingeringPane {");
  assert.match(after, /if \(!\[self focusRememberedDevToolsIn:window\]\) \[self focusPage\];/);
  const remembered = body(focus, "- (BOOL)focusRememberedDevToolsIn:(NSWindow *)window {");
  assert.match(remembered, /_focus\.page != ArdiaPageFocus::DevTools \|\| devTools\.window != window \|\| !_devtoolsView \|\| !\[devTools isDescendantOf:_devtoolsView\]\) return NO;\s*\[window makeFirstResponder:devTools\];/);
});

test("a focus handoff's late page refocus stands down when a newer gate has opened in the window", () => {
  const end = body(handoff, "private func end(_ gate: Gate, restoring: Bool", "\n  }\n");
  assert.notEqual(end, "", "FocusHandoff's end(_:restoring:) is found");
  assert.match(end, /afterPendingUI \{[^}]*guard [^\n]*Self\.unfocused\(window\), self\.gates\[ObjectIdentifier\(window\)\] == nil else \{ return \}[\s\S]*ArdiaWebView\.focusVisiblePage\(in: window\)/);
});

test("lending a page to a successor asks the successor to take the focus the page held", () => {
  const lend = body(standIn, "- (void)lendPageToSuccessor");
  assert.match(lend, /const BOOL heldFocus = /);
  assert.match(lend, /if \(heldFocus\) \{[\s\S]*\[holder requestFocusRestoreIn:window\];/);
});

test("a focus handoff that ends without restoring the page refocuses the visible page when the window has no responder", () => {
  const end = body(handoff, "private func end(_ gate: Gate, restoring: Bool", "\n  }\n");
  assert.notEqual(end, "", "FocusHandoff's end(_:restoring:) is found");
  assert.match(end, /guard let window = gate\.window, Self\.unfocused\(window\) else \{ return \}/);
  assert.match(end, /if restoring, [^\n]*\{\s*window\.makeFirstResponder\(page\)\s*return\s*\}\s*afterPendingUI \{/);
  assert.match(end, /afterPendingUI \{[\s\S]*Self\.unfocused\(window\)[\s\S]*ArdiaWebView\.focusVisiblePage\(in: window\)/);
});

test("the hover probe repairs a key window with no first responder on a click over the page", () => {
  const safe = body(probe, "bool SafeToHeal(");
  assert.match(
    safe,
    /HoverReason::responderLost\) \{\s*if \(trigger != HoverTrigger::click\) refusal = HealRefusal::notClick;\s*else if \(!\(check\.overPage && check\.windowKey\)\) refusal = HealRefusal::notEligible;/,
  );
  const heal = body(probe, "void Heal(");
  assert.match(heal, /reason == HoverReason::responderLost\) \{\s*if \(NSView \*page = PageUnder\(window, point\)\) \[window makeFirstResponder:page\];/);
});

const refusals = [
  "notVisible",
  "notOnActiveSpace",
  "notInFront",
  "modalWindow",
  "attachedSheet",
  "savePanel",
  "menuActive",
  "menuShown",
  "fullScreenMoving",
  "notClick",
  "keyPopup",
];

test("SafeToHeal names the first guard that refuses, in the order the guards are checked, and allows what it always did", () => {
  const guards = body(probe, "HealRefusal GuardRefusal(");
  assert.notEqual(guards, "", "GuardRefusal is found");
  const order = [
    "if (!window.isVisible) return HealRefusal::notVisible;",
    "if (!window.isOnActiveSpace) return HealRefusal::notOnActiveSpace;",
    "if (!check.activation.inFront()) return HealRefusal::notInFront;",
    "if (panel != HealRefusal::none) return panel;",
    "if (check.menuActive) return HealRefusal::menuActive;",
    "if (MenuShown(window, menuWindow)) return HealRefusal::menuShown;",
    "if (FullScreenMoving()) return HealRefusal::fullScreenMoving;",
  ].map((line) => guards.indexOf(line));
  assert.ok(order.every((at) => at >= 0), "every guard returns its own refusal");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the guards keep their order");

  const panel = body(probe, "HealRefusal PanelOrSheetRefusal(");
  assert.match(panel, /if \(NSApp\.modalWindow\) return HealRefusal::modalWindow;/);
  assert.match(panel, /if \(window\.attachedSheet\) return HealRefusal::attachedSheet;/);
  assert.match(panel, /NSSavePanel\.class\]\) return HealRefusal::savePanel;/);

  const safe = body(probe, "bool SafeToHeal(");
  assert.match(safe, /HoverReason::halfActive\) \{\s*if \(trigger != HoverTrigger::click && trigger != HoverTrigger::key\) refusal = HealRefusal::notClick;\s*else if \(check\.key == FocusWindowKind::popup\) refusal = HealRefusal::keyPopup;/);
  assert.match(safe, /HoverReason::notKeyOrMain && check\.activation\.appActive && Unseen\(check\.key\) && !OtherArdiaWindowActive\(window\)\)\) \{\s*refusal = HealRefusal::notEligible;/);
  assert.match(safe, /return refusal == HealRefusal::none;/);

  const names = body(probeRefusal, "NSString *HealRefusalName(");
  for (const name of refusals) assert.ok(names.includes(`@"${name}"`), `${name} is named`);
  const enumeration = /enum class HealRefusal \{([^}]*)\}/.exec(probeInternal)?.[1] ?? "";
  for (const name of refusals) assert.match(enumeration, new RegExp(`\\b${name}\\b`), `${name} is a HealRefusal`);
});

test("a refused repair keeps its first and last refusal on the episode, and the window a menu check matched", () => {
  const episode = /struct HoverEpisode \{([\s\S]*?)\n\};/.exec(probeInternal)?.[1] ?? "";
  assert.match(episode, /HealRefusal firstRefusal = HealRefusal::none;/);
  assert.match(episode, /HealRefusal lastRefusal = HealRefusal::none;/);
  assert.match(episode, /MenuWindowInfo refusedWindow;/);
  assert.match(episode, /NSUInteger otherWindowClicks = 0;/);

  const note = body(probe, "void NoteHealRefusal(");
  assert.match(note, /if \(gEpisode\.firstRefusal == HealRefusal::none\) gEpisode\.firstRefusal = refusal;/);
  assert.match(note, /gEpisode\.lastRefusal = refusal;/);
  assert.match(note, /if \(refusal == HealRefusal::menuShown && !gEpisode\.refusedWindow\.present\) gEpisode\.refusedWindow = menuWindow;/);

  const handle = body(probe, "void HandleHoverCheck(");
  assert.match(handle, /if \(gEpisode\.healed\) return;\s*HealRefusal refusal = HealRefusal::none;\s*MenuWindowInfo menuWindow;/);
  assert.match(handle, /if \(SafeToHeal\(window, check, trigger, &refusal, &menuWindow\)\) Heal\(window, point, check\.reason\);\s*else NoteHealRefusal\(refusal, menuWindow\);/);
});

test("MenuShown reports the matching window as enums, never as its class name", () => {
  const shown = body(probeRefusal, "bool MenuShown(");
  assert.match(shown, /if \(matched\) \*matched = DescribeMenuWindow\(window, browser\);\s*return true;/);
  const describe = body(probeRefusal, "MenuWindowInfo DescribeMenuWindow(");
  assert.match(describe, /info\.level = MenuWindowLevel::popUp;/);
  assert.match(describe, /window\.parentWindow == browser \? MenuWindowParent::browser : MenuWindowParent::other;/);
  assert.doesNotMatch(describe, /stringWithFormat|return name/, "the class name is only compared, never kept");
  const name = body(probeRefusal, "NSString *MenuWindowName(");
  assert.match(name, /return \[NSString stringWithFormat:@"%@:%@:%@", kind, level, parent\];/);
  assert.match(name, /if \(!info\.present\) return @"none";/);
});

test("a click in another browser window while an episode is open is counted, and an app-wide halfActive episode moves to that window so the click can repair it", () => {
  const handle = body(probe, "void HandleHoverCheck(");
  assert.match(
    handle,
    /if \(!window\) return;\s*if \(gEpisode\.open && gEpisode\.owner != window && trigger != HoverTrigger::key\) \{\s*if \(trigger != HoverTrigger::click\) return;\s*gEpisode\.otherWindowClicks\+\+;\s*if \(gEpisode\.first\.reason != HoverReason::halfActive \|\| gEpisode\.healed\) return;\s*gEpisode\.owner = window;\s*\}\s*const HoverCheck check = Probe\(window/,
  );
});

test("the episode record carries the refusal, the matched window and the other-window clicks out to page_hover_lost and the dev state", () => {
  const close = body(probeEpisode, "NSDictionary *EpisodePayload(");
  assert.match(close, /@"healRefused" : HealRefusalName\(gEpisode\.firstRefusal\),/);
  assert.match(close, /@"healRefusedLast" : HealRefusalName\(gEpisode\.lastRefusal\),/);
  assert.match(close, /@"healRefusedWindow" : MenuWindowName\(gEpisode\.refusedWindow\),/);
  assert.match(close, /@"otherWindowClicks" : @\(gEpisode\.otherWindowClicks\),/);
  assert.match(probeDev, /@"healRefused" : HealRefusalName\(gEpisode\.firstRefusal\),/);
  assert.match(probeDev, /@"healRefusedLast" : HealRefusalName\(gEpisode\.lastRefusal\),/);
  assert.match(probeDev, /@"healRefusedWindow" : MenuWindowName\(gEpisode\.refusedWindow\),/);
  assert.match(probeDev, /@"otherWindowClicks" : @\(gEpisode\.otherWindowClicks\),/);
});

const jsSet = (name) => new Set([...(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`).exec(hoverLostJs)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]));

test("an episode still open when Ardia quits is reported as ended by quit before JS hears willQuit, and stays open in case the quit is cancelled", () => {
  const terminate = body(quitFlow, "func shouldTerminate()", "\n  }\n");
  const reported = terminate.indexOf("ArdiaHost.reportHoverLossAtQuit()");
  const told = terminate.indexOf('ShellEvents.send(.app, ["type": "willQuit"])');
  assert.ok(reported > 0 && told > reported, "JS holds the episode before it saves for the quit");
  const atQuit = body(probeEpisode, "void ReportHoverEpisodeAtQuit(");
  assert.match(atQuit, /if \(!gEpisode\.open\) return;/);
  assert.match(atQuit, /EmitEpisode\(EpisodePayload\(@"quit"\), gEpisode\.stamp\);/);
  assert.doesNotMatch(atQuit, /CloseEpisode|HoverEpisode\{\}/, "the episode stays open until the quit commits");
  assert.doesNotMatch(probeDev, /@"quit"/, "no dev shortcut stands in for the real quit");
  assert.ok(jsSet("HOVER_ENDINGS").has("quit"), "JS keeps the quit ending");
});

test("a page covered by a view reports the kind of view, the kind that made it see-through and how much it covered, as enums JS knows", () => {
  const reason = body(probe, "HoverReason PageReason(");
  assert.match(reason, /check\.coverView = CoverViewOf\(hit\);\s*NSView \*clear = SeeThroughView\(hit\);\s*check\.coverClear = clear != nil;\s*check\.coverClearView = CoverViewOf\(clear\);\s*check\.coverSize = CoverSizeOver\(clear \?: hit, page\);/);
  const close = body(probeEpisode, "NSDictionary *EpisodePayload(");
  assert.match(close, /@"coverView" : CoverViewName\(first\.coverView\),/);
  assert.match(close, /@"coverClearView" : CoverViewName\(first\.coverClearView\),/);
  assert.match(close, /@"coverSize" : CoverSizeName\(first\.coverSize\),/);
  const names = (header) => [...body(probeCover, header).matchAll(/@"([A-Za-z]+)"/g)].map((m) => m[1]);
  const enumOf = (name) => (new RegExp(`enum class ${name} \\{([^}]*)\\}`).exec(probeInternal)?.[1] ?? "").split(",").map((v) => v.trim());
  assert.deepEqual(names("NSString *CoverViewName("), enumOf("CoverView"), "CoverViewName follows the enum's order");
  assert.deepEqual(names("NSString *CoverSizeName("), enumOf("CoverSize"), "CoverSizeName follows the enum's order");
  assert.deepEqual([...jsSet("HOVER_COVER_VIEWS")].sort(), [...enumOf("CoverView")].sort());
  assert.deepEqual([...jsSet("HOVER_COVER_SIZES")].sort(), [...enumOf("CoverSize")].sort());
  const kinds = body(probeCover, "CoverView CoverViewOf(");
  assert.doesNotMatch(kinds, /return name|stringWithFormat/, "a class name is only compared, never kept");
});

test("a quit report commits only on real termination past cancellation points, stays open on Stay, and writes durably before pruning", () => {
  assert.match(body(probeEpisode, "NSDictionary *EpisodePayload("), /@"serial" : @\(gEpisode\.serial\),/);
  assert.match(body(probeEpisode, "void ReportHoverEpisodeAtQuit("), /gReportedAtQuit = gEpisode\.serial;\s*gQuitWindowClosed = false;\s*EmitEpisode\(/);
  assert.match(body(probeEpisode, "bool HoverEpisodeReportedAtQuitOpen("), /return gReportedAtQuit != 0 && gEpisode\.open && gEpisode\.serial == gReportedAtQuit;/);
  assert.match(body(probeEpisode, "NSInteger HoverEpisodeReportedAtQuitSeconds("), /if \(!HoverEpisodeReportedAtQuitOpen\(\)\) return -1;\s*return MIN\(86400, lround\(MAX\(0, Uptime\(\) - gEpisode\.startedAt\)\)\);/);
  assert.match(body(probeEpisode, "void MarkHoverEpisodeCommittedAtQuit("), /gEpisode = HoverEpisode\{\};\s*gPendingReason = HoverReason::fine;\s*ClearQuitReport\(\);/);
  assert.match(body(probeEpisode, "void CancelHoverEpisodeAtQuit("), /const bool windowClosed = QuitWindowClosedPending\(\);\s*ClearQuitReport\(\);\s*if \(windowClosed\) CloseEpisode\(@"windowClosed"\);/);
  assert.match(body(probe, "void CloseOwnerWindow("), /if \(!gEpisode\.open \|\| DeferWindowCloseForQuit\(\)\) return;\s*CloseEpisode\(@"windowClosed"\);/);
  assert.match(body(probe, "void WatchHover("), /if \(gEpisode\.open && note\.object == gEpisode\.owner\) CloseOwnerWindow\(\);/);
  assert.match(quitFlow, /forName: NSApplication\.willTerminateNotification, object: nil, queue: nil\s*\) \{ _ in commitHeldHoverLoss\(\) \}/);
  assert.match(quitFlow, /forName: PluginProgramLinks\.quitCancelledNotification, object: nil, queue: nil\s*\) \{ _ in cancelHeldHoverLoss\(\) \}/);
  const commit = body(quitFlow, "static func commitHeldHoverLoss()", "\n  }\n");
  assert.match(commit, /guard ArdiaHost\.hoverLossReportedAtQuitIsOpen\(\), let held = DocumentStore\.read\(heldHoverLoss\) else \{ return \}/);
  assert.match(commit, /ArdiaHost\.hoverLossReportedAtQuitSeconds\(\)/);
  assert.match(commit, /HoverLossQuitCommit\.commit\(/);
  assert.match(commit, /DocumentStore\.writeDurablySync\(\$0, \$1, allowWhenClosed: true\)/);
  assert.match(commit, /ArdiaHost\.markHoverLossCommittedAtQuit\(\)/);
  assert.match(commit, /DocumentStore\.removeSync\(heldHoverLoss, allowWhenClosed: true\)/);
  const cancel = body(quitFlow, "static func cancelHeldHoverLoss()", "\n  }\n");
  assert.match(cancel, /ArdiaHost\.cancelHoverLossAtQuit\(\)\s*DocumentStore\.removeSync\(heldHoverLoss, allowWhenClosed: true\)/);
  const settled = body(quitFlow, "private func quitAfterUpdaterSettles()", "\n  }\n");
  assert.doesNotMatch(settled, /commitHeldHoverLoss/, "does not commit before Chromium's beforeunload prompt can cancel quit");
  const reply = body(quitFlow, "func replyToTerminate(", "\n  }\n");
  assert.match(reply, /Self\.cancelHeldHoverLoss\(\)\s*return NSApp\.reply\(toApplicationShouldTerminate: false\)/);
  const terminate = body(quitFlow, "func shouldTerminate()", "\n  }\n");
  assert.ok(terminate.indexOf("_ = Self.commitsHoverLossOnTerminate") < terminate.indexOf("ArdiaHost.reportHoverLossAtQuit()"), "the commit watch is in place before the report");
  assert.ok(terminate.indexOf("_ = Self.cancelsHoverLossOnQuitCancelled") < terminate.indexOf("ArdiaHost.reportHoverLossAtQuit()"), "the cancel watch is in place before the report");
  const helper = body(quitCommit, "static func commit(", "\n  }\n");
  assert.ok(helper.indexOf("guard write(target, prepared.json) else { return false }") > 0);
  assert.ok(helper.indexOf("guard write(target, prepared.json) else { return false }") < helper.indexOf("list(prefix)"), "writes durably before listing or pruning committed records");
});

test("a key press in a half-active Ardia repairs it as a click does, and a key never opens any other episode", () => {
  const check = body(probe, "bool CheckKeyInHalfActiveApp(NSEvent *event)");
  assert.match(check, /if \(event\.type != NSEventTypeKeyDown\) return false;/);
  assert.match(check, /if \(event\.isARepeat \|\| NSApp\.isActive \|\| !CurrentActivation\(\)\.inFront\(\)\) return true;/);
  assert.match(check, /HandleHoverCheck\(weakWindow, point, HoverTrigger::key, stamp\)/);
  assert.match(body(probe, "NSWindow *BrowserWindowForKey(NSEvent *event)"), /if \(event\.window\) return IsBrowserWindow\(event\.window\) \? event\.window : nil;/);
  assert.match(probe, /NSEventMaskMouseMoved \| NSEventMaskLeftMouseDown \| NSEventMaskKeyDown[\s\S]*?if \(CheckKeyInHalfActiveApp\(event\)\) return event;/);
  const handle = body(probe, "void HandleHoverCheck(NSWindow *window, NSPoint point, HoverTrigger trigger, ArdiaConsentStamp *stamp)");
  const keyGuard = handle.indexOf("if (trigger == HoverTrigger::key && check.reason != HoverReason::halfActive) return;");
  assert.ok(keyGuard >= 0 && handle.indexOf("OpenEpisode(") >= 0 && keyGuard < handle.indexOf("OpenEpisode("), "a key never opens any other kind of episode");
  const keyMove = handle.indexOf("if (trigger == HoverTrigger::key && gEpisode.open && gEpisode.owner != window) {");
  assert.ok(handle.indexOf("if (trigger == HoverTrigger::key && check.reason != HoverReason::halfActive) return;") < keyMove && keyMove > 0, "a key moves or ends another window's episode only once the probe confirms halfActive");
  assert.match(handle.slice(keyMove), /^if \(trigger == HoverTrigger::key && gEpisode\.open && gEpisode\.owner != window\) \{\s*if \(gEpisode\.first\.reason != HoverReason::halfActive\) CloseEpisode\(@"appInactive"\);\s*else if \(gEpisode\.healed\) return;\s*else gEpisode\.owner = window;/);
  assert.match(probeInternal, /enum class HoverTrigger \{ move, click, recheck, key \};/);
  assert.match(probe, /@"move", @"click", @"recheck", @"key"/);
});
