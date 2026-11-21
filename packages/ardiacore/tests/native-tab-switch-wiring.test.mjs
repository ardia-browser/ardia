import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const reveals = read("../ios/ArdiaWebView+Reveals.mm");
const input = read("../ios/ArdiaWebView+RevealInput.mm");
const presses = read("../ios/ArdiaTabPresses.mm");
const painting = read("../ios/ArdiaWebView+Painting.mm");
const tabFile = read("../ios/ArdiaWebView+Tab.mm");
const timing = read("../ios/ArdiaFieldTiming.mm");
const monitors = read("../ios/ArdiaWebView+InputMonitors.mm");
const focus = read("../ios/ArdiaWebView+Focus.mm");
const tabsModule = read("../ios/TabsModule.swift");
const pressArea = read("../../../apps/browser/src/components/sidebar/TabPressArea.tsx");
const heldPress = read("../../../apps/browser/src/state/sidebar/heldTabPress.ts");
const tabReveal = read("../../../apps/browser/src/state/tabs/tabReveal.ts");
const toolbar = read("../../../apps/browser/src/components/toolbar/Toolbar.tsx");
const sidebarField = read("../../../apps/browser/src/components/sidebar/AddressBar.tsx");
const autoHide = read("../../../apps/browser/src/components/toolbar/AutoHideToolbar.tsx");
const pageScript = read("../ios/page_script.js");
const messages = read("../ios/ArdiaWebView+PageMessages.mm");
const webView = read("../ios/ArdiaWebView.mm");
const guards = read("../ios/ArdiaRevealGuards.mm");
const pageView = read("../ios/PageViewDefinition.swift");
const menuTarget = read("../../shell/ios/MenuTarget.swift");
const mainMenu = read("../../shell/ios/MainMenu.swift");
const ledger = read("../ios/ArdiaRevealLedger.h");

const body = (text, signature) => {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  assert.fail(`${signature} is not closed`);
};

test("the window's mouse monitor starts a row's reveal before anything else sees the press", () => {
  const install = body(monitors, "+ (void)installSwitchPrewarm");
  assert.ok(install.indexOf("[ArdiaWebView revealForPress:event]") >= 0);
  assert.ok(install.indexOf("[ArdiaWebView revealForPress:event]") < install.indexOf("[ArdiaWebView prewarmForMouseEvent:event]"));
  assert.match(install, /return event;\n  \}\];/, "the press still goes on to the row");
});

test("only a plain single left press, while JS allows it, on a row of this window reveals its tab", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.match(press, /!gNativeTabSwitch\.load\(/);
  assert.match(reveals, /std::atomic<bool> gNativeTabSwitch/, "JS writes the flag off the main thread");
  assert.match(press, /event\.type != NSEventTypeLeftMouseDown/);
  assert.match(press, /event\.clickCount > 1 \|\| \(event\.modifierFlags & kClickModifiers\)/);
  assert.match(press, /view\.window != window/);
  assert.match(press, /view\.revealsFirst/);
  assert.ok(press.indexOf("[view revealableOver:YES]") >= 0 && press.indexOf("[view revealableOver:YES]") < press.indexOf("replaceRevealsInWindow:window with:view"), "nothing is ended for a reveal that would be refused");
  const replace = body(reveals, "+ (BOOL)replaceRevealsInWindow:(NSWindow *)window with:(ArdiaWebView *)pressed");
  assert.ok(replace.indexOf("[other endReveal]") < replace.indexOf("[pressed revealAhead]") && replace.indexOf("[pressed revealAhead]") < replace.indexOf("[other paintAfterReveal:YES]"), "the page pressed before leaves only once the new one waits for its frame, so it holds the screen until then and the selected page never flashes between them");
  assert.match(press, /\[view noteOnScreenAhead:overAnother\];/, "and the address stays hidden and input swallowed across the hand-over");
  assert.match(press, /if \(view->_reveal\.native\) view->_reveal\.press = press;/, "a second press on the row of the page already shown ahead takes the reveal over, so the first press's rollback leaves it");
  assert.match(body(reveals, "- (void)revealAhead"), /\[self revealableOver:NO\]/);
  const check = body(reveals, "- (ArdiaWebView *)revealableOver:(BOOL)pastOtherReveals");
  assert.match(check, /other->_reveal\.active && !pastOtherReveals/);
  assert.match(check, /NSEqualRects/);
  assert.match(press, /view->_reveal\.native = YES;/);
  assert.match(reveals, /NSEventModifierFlagCommand \| NSEventModifierFlagOption \| NSEventModifierFlagShift \| NSEventModifierFlagControl/);
});

test("a press on a control inside the row, or anywhere but a tagged row, reveals nothing", () => {
  const key = body(reveals, "NSString *PressedTabTag(NSEvent *event)");
  const loop = key.slice(key.indexOf("for ("));
  assert.ok(loop.indexOf("TabSwitchKeyOf(view)") < loop.indexOf("IsRowControl(view)"), "the row itself is found before a control above it would stop the walk");
  assert.match(key, /view != content/);
  assert.match(key, /window\.isKeyWindow \|\| \[hit acceptsFirstMouse:event\]/, "a click that only brings the window forward never reaches the row");
  const control = body(reveals, "BOOL IsRowControl(NSView *view)");
  for (const kind of ["NSControl", "NSText", "NSAccessibilityButtonRole", "NSAccessibilityTextFieldRole", "NSAccessibilityTextAreaRole"]) assert.ok(control.includes(kind), kind);
  assert.match(body(reveals, "NSString *TabSwitchKeyOf(NSView *view)"), /hasPrefix:kTabSwitchTag\] && !\[tag hasPrefix:kTabSelectedTag/);
  const reactTag = body(input, "NSString *ReactTagOf(NSView *view)");
  assert.match(reactTag, /@"nativeID", @"nativeId"/, "the old architecture spells it nativeID, Fabric nativeId");
  assert.match(reactTag, /isKindOfClass:NSString\.class\]\) return tag;/, "a nil nativeID still falls back to nativeId");
  assert.match(reveals, /kTabSwitchTag = @"tab-switch:"/);
});

test("pressing the shown tab's row takes back a native reveal still waiting for JS; a multi-selected row never starts one", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  const visible = press.indexOf("if (view->_visible) {");
  assert.ok(visible >= 0 && visible < press.indexOf("[tag hasPrefix:kTabSwitchTag]"), "the active row is tagged tab-switch, so visibility decides before the tag");
  assert.ok(press.slice(visible).indexOf("[ArdiaWebView dropNativeRevealsInWindow:window];") < press.slice(visible).indexOf("return NO;"));
  assert.match(press, /\[tag hasPrefix:kTabSwitchTag\] && view\.revealsFirst \? \[view revealableOver:YES\] : nil/);
  assert.match(body(reveals, "+ (void)dropNativeRevealsInWindow:(NSWindow *)window"), /other->_reveal\.native\) \[other dropReveal\]/);
  assert.match(reveals, /kTabSelectedTag = @"tab-selected:"/);
});

test("a page shown ahead of JS is pixels only: keys and clicks at the page are swallowed, and nothing moves hit testing or the keyboard", () => {
  const install = body(monitors, "+ (void)installSwitchPrewarm");
  assert.match(install, /addLocalMonitorForEventsMatchingMask:kRevealInputMask/);
  assert.ok(install.indexOf("if ([ArdiaWebView swallowsAheadOfSwitch:event]) return nil;") < install.indexOf("[ArdiaWebView revealForPress:event]"), "a swallowed event starts nothing either");
  assert.match(input, /kRevealInputMask = kButtonDowns \| kButtonUps \| kButtonDrags \| kKeys \| kPointer;/);
  const swallow = body(input, "+ (BOOL)swallowsAheadOfSwitch:(NSEvent *)event");
  assert.match(swallow, /if \(!gOnScreenAhead && \(!button \|\| gPresses\.Idle\(\)\)\) return NO;/, "no pointer event is looked at while no page is ahead of JS");
  assert.match(swallow, /const BOOL overCoveredPage = lands && gOnScreenAhead && \[ArdiaWebView revealGapIn:event\.window\] && InTabPage\(HitInWindow\(event\)\);/, "only in the window showing one; clicks, scrolls and hover over a page, the chrome keeps its own");
  assert.match(body(input, "+ (ArdiaWebView *)onScreenAheadIn:(NSWindow *)window"), /if \(!gOnScreenAhead \|\| !window\) return nil;/, "the focus paths that ask on every paint pay nothing while no page is ahead");
  assert.match(swallow, /if \(type & kKeys\) return \[ArdiaWebView swallowsKeyAheadOfSwitch:event\];/);
  assert.match(body(input, "+ (BOOL)swallowsKeyAheadOfSwitch:(NSEvent *)event"), /const BOOL ahead = gOnScreenAhead && window && \[ArdiaWebView revealGapIn:window\] && InTabPage\(keyboard\);/, "keys aimed at a page; the sidebar and the toolbar keep theirs");
  assert.match(body(ledger, "struct PressLedger"), /if \(!\(held & bit\) \|\| window\[slot\] != inWindow\) return false;/, "a release or drag is swallowed only when its press was, so a press on a row always gets its release");
  for (const gone of ["pointerEvents", "makeFirstResponder", "method_setImplementation", "objc/runtime"]) assert.equal(input.includes(gone), false, gone);
  for (const gone of ["takeInputIfShown", "takeHitTesting", "giveFocusBack", "takeFocusFrom:", "inputTaken", "storedAtReveal", "nativeRevealFocus"])
    for (const file of [reveals, input, focus, painting]) assert.equal(file.includes(gone), false, gone);
});

test("the address and the page's other identity are hidden only while that page's pixels are on screen ahead of JS", () => {
  const shown = body(input, "- (void)noteOnScreenAhead");
  assert.match(shown, /const BOOL painted = !_frameHold\.awaiting && self\.alphaValue >= 1;/);
  assert.match(shown, /if \(!_reveal\.onScreen && \(painted \|\| overAnother\)\) \{/, "not while it waits for its first frame at alpha 0 over the selected page: that page is still the one on screen");
  assert.ok(shown.indexOf("_reveal.onScreen = YES;") < shown.indexOf("[self hidePageIdentity]"));
  assert.ok(shown.indexOf("if (!painted || _reveal.painted) return;") < shown.indexOf('@"nativeReveal")'), "counted as shown only once its own pixels are up");
  assert.match(shown, /ArdiaFieldMarkAtCommit\(_transferKey, @"view"\)/, "the view mark is the frame the page is on screen");
  const paint = body(painting, "- (void)applyPainting");
  assert.ok(paint.indexOf("[self noteOnScreenAhead:NO]") > paint.indexOf("[CATransaction commit]"), "once the first-frame hold ends, the same paint notes it");
  const hide = body(input, "- (void)hidePageIdentity");
  assert.match(hide, /CollectPageIdentity\(content, found\)/, "every tagged view of the window: toolbar, collapsed toolbar, sidebar field");
  assert.match(hide, /view\.alphaValue = 0;/);
  assert.match(hide, /setDisableActions:YES/, "in the same frame, no fade");
  assert.match(input, /kPageIdentityTag = @"page-identity"/);
  const left = body(input, "- (void)leaveScreenAhead {");
  assert.match(left, /view\.alphaValue = \[hidden objectForKey:view\]\.doubleValue;/);
  assert.ok(body(reveals, "- (void)endReveal").includes("[self leaveScreenAheadOnceGone]"), "settle, drop, backstop and detach all show it again");
  assert.match(body(reveals, "- (BOOL)stayOver:(ArdiaWebView *)shown"), /if \(_reveal\.onScreen\) \[self hidePageIdentityAfterMount\];/, "an earlier press's commit renames the toolbar under the page on screen: still hidden");
  assert.match(tabReveal, /PAGE_IDENTITY_TAG = PLATFORM_FEATURES\.nativeTabSwitch \? "page-identity" : undefined/);
  assert.match(toolbar, /<View nativeID=\{PAGE_IDENTITY_TAG\} collapsable=\{false\} pointerEvents="box-none" style=\{StyleSheet\.absoluteFill\}>\s*\{tab\.url \? \(\s*<ToolbarUrlField/, "the field holds the address, the lock, the capture and pop-up marks");
  assert.match(sidebarField, /nativeID=\{PAGE_IDENTITY_TAG\}\s*collapsable=\{false\}/);
  assert.match(autoHide, /<Pressable\s*nativeID=\{PAGE_IDENTITY_TAG\}\s*collapsable=\{false\}[\s\S]*?\{host\}/, "the collapsed toolbar's host label");
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.match(press, /isEqualToString:kSmallWindow\] \|\| TypingOutsidePages\(window\) \|\| ArdiaTabInSplit\(key\)\) return NO;/, "Little Ardia, an open address field and split rows keep the JS path");
  assert.match(tabReveal, /!Object\.keys\(useMedia\.getState\(\)\.tabShares\)\.length && !popoverOpen\(\)/, "a page popover names the page under it");
});

test("no page takes the keyboard while one is on screen ahead of JS, whoever asks; what was asked happens once it ends", () => {
  const page = body(focus, "- (void)focusPage");
  assert.ok(page.indexOf("[ArdiaWebView onScreenAheadIn:self.window]") < page.indexOf("[_tab focus]"), "every path ends here: JS's focus(), a load, the window becoming key, an activation");
  assert.match(page, /if \(\[ArdiaWebView onScreenAheadIn:self\.window\]\) return \[self askFocusAheadOfSwitch:NO\];/);
  const restore = body(focus, "- (void)restoreFocusIfDue");
  assert.ok(restore.indexOf("if ([ArdiaWebView onScreenAheadIn:window]) return;") < restore.indexOf("_focus.onActivate = NO;\n  NSResponder"), "an activation under the page on screen stays due");
  const after = body(input, "+ (void)focusPagesAskedAheadOfSwitch");
  assert.match(after, /if \(\[ArdiaWebView revealGapIn:window\]\) continue;/);
  assert.match(after, /if \(view->_visible\) \[view focusPage\];\n    else \[ArdiaWebView focusVisiblePageIn:window\];/, "the page that asked if JS still has it in front, else the one JS switched to: where the keyboard would be had the request not waited");
  assert.ok(body(input, "- (void)leaveScreenAhead {").includes("[ArdiaWebView focusPagesAskedAheadOfSwitch]"));
  assert.equal(body(reveals, "- (void)settleRevealsInWindow").includes("focus"), false, "a commit focuses its page the way it does without a reveal");
});

test("a page with a dialog, a sheet, a bubble over it, pointer lock or full screen is never covered", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.match(press, /if \(!shown \|\| HoldsItsWindow\(shown\)\) return NO;/);
  const holds = body(reveals, "static BOOL HoldsItsWindow(ArdiaWebView *page)");
  assert.match(holds, /page->_reports\.exclusiveFrames\.count \|\| window\.attachedSheet/);
  assert.match(holds, /pageFullScreen/);
  assert.match(holds, /child\.visible && NSIntersectsRect\(child\.frame, onScreen\)/, "Chrome's dialogs and bubbles are child windows over the page");
  assert.match(pageScript, /send\("exclusive", \{ held: !!\(document\.pointerLockElement \|\| document\.fullscreenElement\) \}\)/);
  assert.match(pageScript, /document\.addEventListener\("pointerlockchange", tellExclusive\);\n  document\.addEventListener\("fullscreenchange", tellExclusive\);/);
  assert.match(messages, /if \(Flag\(dict, @"held"\)\) \[_reports\.exclusiveFrames addObject:frameId\];\n    else \[_reports\.exclusiveFrames removeObject:frameId\];/);
  assert.match(messages, /if \(main\) _reports\.exclusiveFrames = nil;/, "a new document starts clean");
});

test("every press has a sequence number that travels with its own event: only the commit of an older press goes under the page on screen", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.ok(press.indexOf("ArdiaTabPressBegan(key, event.timestamp * 1000)") < press.indexOf("event.clickCount > 1"), "every press JS will hear is numbered, revealed or not, under its event's time");
  assert.match(press, /view->_reveal\.press = press;/);
  assert.match(body(presses, "NSUInteger ArdiaTabPressBegan(NSString *key, double stamp)"), /const NSUInteger press = \+\+gLastPress;/);
  const claim = body(presses, "NSUInteger ArdiaTabPressClaim(NSString *key, double stamp)");
  assert.match(claim, /if \(!\[entry\[0\] isEqualToString:key\] \|\| std::fabs\(\[entry\[2\] doubleValue\] - stamp\) > kSameEventMs\) continue;/, "the tab and the event both have to match: never the oldest press on that tab");
  assert.match(tabsModule, /Function\("claimTabPress"\) \{ \(key: String, stamp: Double\) -> Int in Int\(ArdiaWebView\.claimTabPress\(key, stamp: stamp\)\) \}/);
  assert.match(heldPress, /const nativePress = claimPress\(tabId, startedAt\);/, "the touch's own start time, which React Native takes from the same NSEvent");
  assert.match(heldPress, /switchingByPress\(nativePress, \(\) => clickTab\(windowId, tabId\)\)/);
  assert.match(tabReveal, /else revealTab\(change\.tabId, pressSwitching\);/);
  assert.match(tabReveal, /dropTabReveals\(change\.over, pressSwitching, change\.to\)/);
  const reveal = body(reveals, "+ (void)revealTab:(NSString *)transferKey press:(NSUInteger)press");
  assert.ok(reveal.indexOf("ArdiaTabSwitchNote(key, press)") < reveal.indexOf("OnMain("), "noted on the JS thread, so it is there before the commit reaches the main thread");
  assert.match(reveal, /if \(pressedLater && OlderPress\(press, pressedLater->_reveal\.press\)\) return;/, "JS's own reveal of an earlier press doesn't take the screen back");
  assert.ok(reveal.indexOf("OlderPress(press") < reveal.indexOf("[ArdiaWebView dropRevealsInWindow:view.window except:view]"), "any other selection ends the reveal and shows itself");
  assert.match(body(reveals, "BOOL OlderPress(NSUInteger press, NSUInteger than)"), /return press && press < than;/, "a selection no press made is never older");
  const settle = body(reveals, "- (void)settleRevealsInWindow");
  assert.match(settle, /const NSUInteger press = ArdiaTabSwitchTake\(_transferKey\);/);
  assert.match(settle, /if \(pressedLater && OlderPress\(press, pressedLater->_reveal\.press\) && \[pressedLater stayOver:self\]\) return;/);
  const stay = body(reveals, "- (BOOL)stayOver:(ArdiaWebView *)shown");
  assert.match(stay, /NSEqualRects/, "a page laid out elsewhere (a split) is never covered");
  assert.ok(stay.indexOf("lowered.layer.zPosition = _reveal.loweredPaneZ;") < stay.indexOf("_reveal.loweredPane = shownPane;"), "the pane covered until now gets its place back");
});

test("what a switch noted for its mount dies with its press", () => {
  assert.match(body(presses, "void ArdiaTabSwitchNote(NSString *key, NSUInteger press)"), /if \(\[gSwitches\[i\]\[0\] isEqualToString:key\]\) \[gSwitches removeObjectAtIndex:i\];/, "one note a tab: a later switch to it, press or none, replaces the earlier one");
  const take = body(presses, "NSUInteger ArdiaTabSwitchTake(NSString *key)");
  assert.match(take, /\[gSwitches removeObjectsInRange:NSMakeRange\(0, i \+ 1\)\];/, "the mount takes its note and every older one: those switches never mounted");
  assert.match(body(reveals, "+ (void)dropTabPress:(NSUInteger)press"), /ArdiaTabSwitchesForget\(press\);/);
  assert.match(body(reveals, "- (void)dropReveal"), /ArdiaTabSwitchesForget\(_reveal\.press\);/);
  assert.match(body(presses, "void Keep(NSMutableArray<NSArray *> *__strong &list, NSArray *entry)"), /if \(list\.count >= kMaxKept\) \[list removeObjectAtIndex:0\];/);
});

test("a drop names its press and leaves newer reveals alone", () => {
  assert.match(heldPress, /if \(activeTabId\(useBrowser\.getState\(\), windowId\) !== tabId\) pressLeftTabBehind\(nativePress\);/);
  assert.match(tabReveal, /if \(press\) dropTabPress\(press\);/);
  assert.match(body(reveals, "+ (void)dropTabPress:(NSUInteger)press"), /view->_reveal\.native && view->_reveal\.press == press\) \[view dropReveal\]/);
  assert.match(body(reveals, "+ (void)dropRevealsInWindow:(NSWindow *)window pressedBy:(NSUInteger)press"), /if \(!\(other->_reveal\.native && OlderPress\(press, other->_reveal\.press\)\)\) \[other dropReveal\];/);
});

test("a press JS never hears is rolled back once JS has passed it, counted from the press, so a release a menu or a drag swallowed changes nothing", () => {
  const press = body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event");
  assert.ok(press.indexOf("[ArdiaWebView takeBackPressesUnheardUpTo:press]") < press.indexOf("event.clickCount > 1"), "every numbered press starts it, at the press");
  assert.equal(press.includes("NSEventTypeLeftMouseUp"), false, "nothing waits for the release");
  const clock = body(reveals, "+ (void)takeBackPressesUnheardUpTo:(NSUInteger)press");
  assert.match(clock, /dispatch_async\(dispatch_get_main_queue\(\), \^\{\n      ArdiaTabPressesOnJavaScriptThread\(then\);/, "after the main thread has handed the touch to JS, a turn of the JS thread behind it");
  assert.match(clock, /afterTheTouchReachedJavaScript\(\^\{\n    afterTheTouchReachedJavaScript\(\^\{/, "twice round");
  assert.match(clock, /for \(NSNumber \*unheard in ArdiaTabPressesTakeUnheard\(press\)\) \[ArdiaWebView dropTabPress:unheard\.unsignedIntegerValue\];/);
});

test("the JS thread's hook is read under the lock, and a new bridge takes back every page shown ahead of the old one", () => {
  assert.match(tabsModule, /ArdiaWebView\.setJavaScriptThread \{ \[weak self\] block in self\?\.appContext\?\.executeOnJavaScriptThread\(runBlock: block\) \}/);
  assert.match(tabsModule, /OnDestroy \{\s*ArdiaWebView\.endRevealsAheadOfSwitch\(\)\s*\}/);
  const set = body(presses, "void ArdiaTabPressesSetJavaScriptThread(void (^run)(void (^)(void)))");
  assert.match(set, /Locked lock;\n  gOnJavaScriptThread = \[run copy\];\n  \[gUnheard removeAllObjects\];\n  \[gSwitches removeAllObjects\];/);
  const run = body(presses, "void ArdiaTabPressesOnJavaScriptThread(void (^block)(void))");
  assert.match(run, /Locked lock;\n    run = gOnJavaScriptThread;/);
  assert.ok(body(reveals, "+ (void)setJavaScriptThread:(void (^)(void (^)(void)))run").includes("[ArdiaWebView endRevealsAheadOfSwitch]"));
  assert.match(body(reveals, "+ (void)endRevealsAheadOfSwitch"), /OnMain\(\^\{\n    \[ArdiaWebView dropNativeRevealsInWindow:nil\];/);
});

test("a page shown ahead of JS ends at once when a split is made around it, the app or the window is left, or its view leaves the window", () => {
  const splits = body(reveals, "+ (void)setTabsInSplits:(NSArray<NSString *> *)transferKeys");
  assert.match(splits, /\(view->_visible \|\| view->_reveal\.native\) && ArdiaTabInSplit\(view->_transferKey\)\) \[ArdiaWebView dropNativeRevealsInWindow:view\.window\];/, "the page shown or the page under it");
  const left = body(reveals, "void EndRevealsWhenTheWindowIsLeft()");
  for (const name of ["NSApplicationDidResignActiveNotification", "NSWorkspaceActiveSpaceDidChangeNotification", "NSWindowWillEnterFullScreenNotification", "NSWindowWillExitFullScreenNotification", "ArdiaWindowSeenDidChange"]) assert.ok(left.includes(name), name);
  assert.match(left, /\[ArdiaWindowController userSees:window\]\)\) return;/, "a window the user can see again ends nothing");
  assert.match(body(reveals, "+ (void)dropNativeRevealsInWindow:(NSWindow *)window"), /\(!window \|\| other\.window == window\) && other->_reveal\.native\) \[other dropReveal\]/);
  assert.match(body(webView, "- (void)viewWillMoveToWindow:(NSWindow *)newWindow"), /if \(self\.window && newWindow != self\.window && \(_visible \|\| _reveal\.active\)\) \[ArdiaWebView dropNativeRevealsInWindow:self\.window\];/);
});

test("a sleeping, closed, crashed, non-web, split or other profile's page is never shown ahead of JS, and one that fails while shown is taken back", () => {
  const first = body(reveals, "- (BOOL)revealsFirst");
  for (const guard of ["_tab.closed", "_tab.discarded", "_reports.crashed", "_life.closed()", "_visible", "_reveal.active", "_warm", "_standalone", "ArdiaTabInSplit(_transferKey)"]) assert.ok(first.includes(guard), guard);
  assert.match(first, /hasPrefix:@"https:"/);
  assert.match(first, /other->_tab\.profile == _tab\.profile/);
  assert.match(tabReveal, /PLATFORM_FEATURES\.nativeTabSwitch && !inSplit \? `\$\{selected \? "tab-selected" : "tab-switch"\}:\$\{tabId\}` : undefined/);
  assert.match(pressArea, /const inSplit = !!useSplitOf\(tab\.id\);/);
  assert.match(tabReveal, /if \(PLATFORM_FEATURES\.nativeTabSwitch && s\.splits !== prev\.splits\) setTabsInSplits\(tabsInSplits\(s\)\);/);
  assert.match(body(tabFile, "- (void)tab:(ArdiaCoreTab *)tab rendererGone:(NSString *)status code:(int)code"), /\[self dropReveal\];/);
  assert.match(body(tabFile, "- (void)tabDidChangeDiscarded:(ArdiaCoreTab *)tab"), /if \(tab\.discarded\) \[self dropReveal\];/);
  assert.match(body(tabFile, "- (void)detach"), /\[self dropReveal\];/, "a tab closed while shown counts as taken back");
});

test("another Space's warm page blocks the reveal only while it is awake", () => {
  const check = body(reveals, "- (ArdiaWebView *)revealableOver:(BOOL)pastOtherReveals");
  assert.match(check, /if \(\(other->_warm && !other\.neighbourPageAsleep\) \|\| \(other->_reveal\.active && !pastOtherReveals\)\) return nil;/);
  assert.match(body(painting, "- (BOOL)neighbourPageAsleep"), /if \(!_warm \|\| !_neighbour \|\| _visible\) return NO;/, "asleep means another Space's page that is not painting");
});

test("a native reveal that is taken back is marked, one a later press replaces or JS settles is not, and the press time is kept", () => {
  const drop = body(reveals, "- (void)dropReveal");
  assert.ok(drop.indexOf('if (_reveal.painted) ArdiaFieldMarkNow(PressMarkKey(_reveal.press), @"nativeRevealDropped")') < drop.indexOf("[self endReveal]"), "only a page that was on screen counts as taken back, under its press");
  assert.equal(body(reveals, "+ (BOOL)replaceRevealsInWindow:(NSWindow *)window with:(ArdiaWebView *)pressed").includes("dropReveal"), false, "its own switch still follows");
  assert.match(body(reveals, "- (void)endReveal"), /_reveal\.native = NO;/);
  assert.match(body(reveals, "+ (BOOL)revealForPress:(NSEvent *)event"), /ArdiaFieldMark\(PressMarkKey\(press\), @"nativePress", ArdiaFieldEventTime\(event\)\)/, "under the press's number, not the tab's");
  assert.match(input, /stringWithFormat:@"press:%lu", \(unsigned long\)_reveal\.press\], @"nativeReveal"\)/);
  assert.match(timing, /double ArdiaFieldEventTime\(NSEvent \*event\)/);
});

test("JS tags rows and switches the native path off with tab shares", () => {
  assert.match(tabsModule, /Function\("setNativeTabSwitch"\) \{ \(enabled: Bool\) in ArdiaWebView\.setNativeTabSwitch\(enabled\) \}/);
  assert.match(pressArea, /nativeID=\{tabPressTag\(tab\.id, selected, inSplit\)\}/);
  assert.match(pressArea, /collapsable=\{false\}/);
  assert.match(tabReveal, /tabShares/);
});

test("one question, is a page on screen ahead of JS in this window, answers for every way into a page", () => {
  assert.match(body(input, "+ (BOOL)revealGapIn:(NSWindow *)window"), /return \[ArdiaWebView onScreenAheadIn:window\] != nil;/);
  const refuses = body(input, "+ (BOOL)refusesInputAheadOfSwitch:(id)target");
  assert.match(refuses, /if \(!gOnScreenAhead\) return NO;/, "free while no page is ahead");
  assert.match(refuses, /return InTabPage\(view\) && \[ArdiaWebView revealGapIn:view\.window\];/);
  assert.match(refuses, /\[holder accessibilityParent\]/, "an accessibility element answers for the page that holds it");
  for (const asked of ["swallowsAheadOfSwitch:(NSEvent *)event", "swallowsKeyAheadOfSwitch:(NSEvent *)event", "focusPagesAskedAheadOfSwitch", "acceptDropsIfShown"])
    assert.ok(body(input, asked).includes("[ArdiaWebView revealGapIn:"), asked);
  assert.equal((guards.match(/Refused\(/g) ?? []).length >= 10, true, "actions, Services, the Touch Bar, drops and accessibility all ask it");
});

test("a page taken back leaves the screen in the frame its input and address come back", () => {
  const end = body(reveals, "- (void)endReveal");
  assert.equal(end.includes("[self leaveScreenAhead]"), false, "ending the reveal alone restores nothing");
  const paint = body(reveals, "- (void)paintAfterReveal:(BOOL)native");
  assert.ok(paint.indexOf("[self leaveScreen]") < paint.indexOf("_leave.active = NO;") && paint.indexOf("_leave.active = NO;") < paint.indexOf("[self applyPainting]"), "no 100 ms linger above the selected page");
  const settle = body(input, "- (void)settleOnScreenAhead");
  assert.match(settle, /if \(!_reveal\.onScreen \|\| \(_reveal\.active && _reveal\.native\) \|\| self\.leavingScreenAhead\) return;\n  \[self leaveScreenAhead\];/);
  assert.match(body(input, "- (BOOL)leavingScreenAhead"), /return !_visible && self\.window && _frameHold\.holding;/, "a page still held up for the next one keeps the window closed to input; one already at alpha 0 does not");
  const applied = body(painting, "- (void)applyPainting");
  assert.ok(applied.indexOf("sub.hidden = !shown") < applied.indexOf("[self settleOnScreenAhead]"), "decided by the paint that hides it");
  const once = body(input, "- (void)leaveScreenAheadOnceGone");
  assert.match(once, /if \(_visible \|\| !self\.window\) return \[self leaveScreenAhead\];/, "a commit ends it at once: that page is the selected one now");
  assert.match(once, /kLeavingBackstopSeconds/);
  const left = body(input, "- (void)leaveScreenAhead {");
  assert.match(left, /if \(!window \|\| \[ArdiaWebView revealGapIn:window\]\) return;/, "the address and drops come back only when no page of the window is ahead");
  for (const also of [body(tabFile, "- (void)detach"), body(webView, "- (void)dealloc"), body(webView, "- (void)viewWillMoveToWindow:(NSWindow *)newWindow")]) assert.ok(also.includes("[self leaveScreenAhead]"));
});

test("a swallowed press stays swallowed to its release, in its window, until that button is pressed again", () => {
  const swallow = body(input, "+ (BOOL)swallowsAheadOfSwitch:(NSEvent *)event");
  assert.match(swallow, /if \(!gOnScreenAhead && \(!button \|\| gPresses\.Idle\(\)\)\) return NO;/, "one test while no page is ahead and no press is held");
  assert.match(swallow, /return gPresses\.Swallows\(\(unsigned\)event\.buttonNumber, press, event\.windowNumber, overCoveredPage\);/);
  const presses = body(ledger, "struct PressLedger");
  assert.ok(presses.indexOf("held &= ~bit;\n      if (!overCoveredPage) return false;") > 0, "a press of that button that goes through forgets the swallowed one");
  assert.match(presses, /if \(!\(held & bit\) \|\| window\[slot\] != inWindow\) return false;\n    if \(press == Press::kUp\) held &= ~bit;\n    return true;/);
  assert.equal(body(input, "- (void)leaveScreenAhead {").includes("gPresses"), false, "the end of the gap does not hand the rest of the gesture to the page");
});

test("a key swallowed ahead of JS, or seen repeating there, stays swallowed until it is released", () => {
  const keys = body(input, "+ (BOOL)swallowsKeyAheadOfSwitch:(NSEvent *)event");
  assert.match(keys, /const BOOL down = modifier \? ModifierIsDown\(code, event\.modifierFlags\) : event\.type == NSEventTypeKeyDown;/, "a modifier by its own key, not its pair's");
  assert.match(keys, /NSWindow \*window = gOnScreenAhead \|\| gKeys\.HeldOver\(code\) \? event\.window : nil;/, "no window lookup while no page is ahead");
  assert.match(keys, /if \(ahead && repeat\) gKeyHolder = keyboard;/);
  assert.match(keys, /gKeys\.Swallows\(code, down, repeat, ahead, keyboard && keyboard == gKeyHolder\);/);
  assert.ok(keys.indexOf("gKeys.Swallows(") < keys.indexOf("gAppWideKeys(event)"), "Quit and Settings are consumed like any other key, then performed");
  const book = body(ledger, "struct KeyLedger");
  assert.match(book, /return wentDown \? held && !holderHasKeyboard : held \|\| ahead;/, "a release reaches the page that had the press, and nobody else");
  assert.match(book, /swallowed\[key\] = held \|\| ahead;/, "a repeat seen ahead of JS is never the next page's first key");
  assert.match(body(ledger, "constexpr bool ModifierIsDown(unsigned keyCode, uint64_t flags)"), /return either == \(own \|\| paired\) \? own : either;/);
  assert.match(mainMenu, /ArdiaWebView\.setAppWideKeys \{ MainMenu\.performAppWideKey\(\$0\) \}/);
  const appWide = body(mainMenu, "private static func appWideItem(for event: NSEvent, in menu: NSMenu?) -> NSMenuItem?");
  assert.match(appWide, /item\.action == #selector\(MenuTarget\.quit\(_:\)\) \|\| \(item as\? CommandItem\)\?\.command == CommandTable\.Command\.openSettings\.rawValue/, "only these two");
  assert.match(appWide, /guard appWide, KeyEquivalentMatch\.matches\(item, event\) else \{ continue \}/, "matched as the menu bar matches");
  assert.equal(mainMenu.includes("performKeyEquivalent"), false);
});

test("keys Chromium sends straight to the key window pass the same gate, once", () => {
  assert.match(body(ledger, "constexpr bool SkipsEventMonitors(bool keyDown, bool keyUp, unsigned keyCode, uint64_t flags)"), /if \(keyUp\) return \(flags & kCommandFlag\) != 0;\n  return keyDown && \(keyCode == kEisuKeyCode \|\| keyCode == kKanaKeyCode\);/);
  const install = body(monitors, "+ (void)installSwitchPrewarm");
  assert.ok(install.indexOf("if ([ArdiaWebView skipsEventMonitors:event]) return event;") < install.indexOf("if ([ArdiaWebView swallowsAheadOfSwitch:event]) return nil;"), "the monitor leaves them to the dispatch guard");
  assert.match(guards, /const SEL dispatch = @selector\(sendEvent:\);/);
  assert.match(guards, /if \(\[ArdiaWebView skipsEventMonitors:event\] && \[ArdiaWebView swallowsAheadOfSwitch:event\]\) return;\n        \(\(void \(\*\)\(id, SEL, id\)\)original\)\(application, dispatch, event\);/);
});

test("a custom accessibility action taken before the gap asks again when it runs", () => {
  const wrap = body(guards, "NSArray<NSAccessibilityCustomAction *> *GuardedCustomActions(id element, NSArray<NSAccessibilityCustomAction *> *actions)");
  assert.match(wrap, /return holder && !Refused\(holder\) && perform\(\);/);
  assert.match(guards, /const SEL customActions = @selector\(accessibilityCustomActions\);/);
  assert.match(guards, /return GuardedCustomActions\(element, \(\(NSArray \* \(\*\)\(id, SEL\)\)original\)\(element, customActions\)\);/);
});

test("a focus asked ahead of JS is replayed for its own tab, under its own condition", () => {
  assert.match(pageView, /AsyncFunction\("focusIfUnfocused"\) \{ \(view: V\) -> Bool in view\.page\.focusPageIfUnfocused\(\) \}/);
  const asks = body(focus, "- (BOOL)focusPageIfUnfocused");
  assert.match(asks, /\[self askFocusAheadOfSwitch:YES\];\n    return NO;/, "nothing was focused yet");
  const replay = body(input, "+ (void)focusPagesAskedAheadOfSwitch");
  assert.match(replay, /if \(!view->_tab \|\| ask\.tab != view->_tab\) continue;/);
  assert.match(replay, /if \(!unfocused && \(ask\.onlyIfUnfocused \|\| !InTabPage\(responder\)\)\) continue;/, "a field or button holding the keyboard keeps it");
  assert.match(body(tabFile, "- (void)detach"), /_focus\.askedAheadOfSwitch = \{\};/);
});

test("menus, Services, the Touch Bar, drops and accessibility are closed to both pages while one is ahead of JS", () => {
  for (const guarded of ["targetForAction:to:from:", "sendAction:to:from:", "validRequestorForSendType:returnType:", "makeTouchBar", "setAccessibilityFocused:", "performDragOperation:", "draggingEntered:", "draggingUpdated:"]) assert.ok(guards.includes(guarded), guarded);
  assert.match(guards, /@"BrowserAccessibilityCocoa", @"AXPlatformNodeCocoa"/);
  assert.match(body(guards, "BOOL ChangesThePage(SEL selector)"), /hasPrefix:@"accessibilityPerform"\] \|\| \[name hasPrefix:@"setAccessibility"\]/, "reading stays; acting is refused");
  assert.match(body(monitors, "+ (void)installSwitchPrewarm"), /\[ArdiaWebView installRevealGuards\];/);
  assert.match(body(input, "- (void)acceptDropsIfShown"), /const BOOL accept = _visible && \(_standalone \|\| !\[ArdiaWebView revealGapIn:self\.window\]\);/);
  assert.match(body(menuTarget, "private func forwardEdit(_ action: Selector, from sender: Any?)"), /if Self\.pageIsCovered \{ return \}/);
  assert.match(body(menuTarget, "func validateMenuItem(_ menuItem: NSMenuItem) -> Bool"), /FocusHandoff\.editActions\.contains\(action\), Self\.pageIsCovered \{ return false \}/);
});
