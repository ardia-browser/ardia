import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("ArdiaCore holds the consent epoch JS sets, empty until JS has set one", () => {
  assert.match(read("../ios/ArdiaEvents.h"), /@property\(class, nonatomic, copy\) NSString \*consentEpoch;/);
  const events = read("../ios/ArdiaEvents.mm");
  assert.match(events, /NSString \*gConsentEpoch = @"";/);
  assert.match(events, /\+ \(NSString \*\)consentEpoch \{\s*os_unfair_lock_lock\(&gConsentEpochLock\);/);
  assert.match(events, /\+ \(void\)setConsentEpoch:\(NSString \*\)epoch \{\s*NSString \*copied = \[epoch copy\] \?: @"";\s*os_unfair_lock_lock\(&gConsentEpochLock\);/);
});

test("a press loop is stamped with the epoch when its outermost loop begins, and its report sends that stamp", () => {
  const focusState = read("../ios/ArdiaFocusState.mm");
  assert.match(focusState, /PointerTrace\(\)\.BeginLoop\(name\.UTF8String \?: "unnamed", Uptime\(\), ArdiaEvents\.consentEpoch\.UTF8String \?: ""\)/);
  assert.match(focusState, /\[\[\[ArdiaConsentStamp alloc\] initWithEpoch:@\(epoch\.c_str\(\)\)\] onto:/);
  assert.doesNotMatch(focusState, /seconds/);
  const trace = read("../ios/ArdiaPointerTrace.h");
  assert.match(trace, /unsigned long BeginLoop\(const std::string &name, double now, const std::string &epoch\)/);
  assert.match(trace, /bool EndLoop\(double now, std::string \*longName, std::string \*epoch\)/);
  assert.match(trace, /bool TakeLongLoop\(unsigned long generation, double now, std::string \*name, std::string \*epoch\)/);
  assert.doesNotMatch(trace, /double \*seconds/);
});

test("a paint check is stamped with the epoch when it is scheduled, and its record sends that stamp", () => {
  const probe = read("../ios/ArdiaPaintProbe.mm");
  const schedule = probe.slice(probe.indexOf("void SchedulePaintCheck"), probe.indexOf("NSString *PaintProbeLine"));
  assert.ok(schedule.indexOf("ArdiaConsentStamp *stamp = ArdiaConsentStamp.begin;") >= 0, "SchedulePaintCheck takes the stamp");
  assert.ok(schedule.indexOf("ArdiaConsentStamp *stamp = ArdiaConsentStamp.begin;") < schedule.indexOf("dispatch_after"), "the stamp is taken before the check is deferred");
  assert.match(schedule, /CheckPainting\(checked, trigger, stamp\)/);
  assert.match(probe, /\[ArdiaEvents emit:@"engine\.windowUnpainted" data:\[stamp onto:record\]\]/);
  assert.doesNotMatch(probe, /@"seconds"/);
});

const IOS = new URL("../ios/", import.meta.url);
const sources = () => readdirSync(IOS).filter((name) => /\.(mm|swift)$/.test(name)).map((name) => [name, readFileSync(new URL(name, IOS), "utf8")]);
const STAMPED = ["engine.devToolsKeyKept", "engine.hoverLost", "engine.pressLoopLong", "engine.windowUnpainted", "engine.cursorRestored", "engine.popupProtectedMedia", "pictureInPictureDragged", "pictureInPictureResized", "pictureInPictureSkip", "autoPictureInPictureKept"];

test("ArdiaConsentStamp takes the epoch once, when an episode begins, and puts it on the payload sent later", () => {
  const header = read("../ios/ArdiaEvents.h");
  assert.match(header, /@interface ArdiaConsentStamp : NSObject/);
  assert.match(header, /\+ \(instancetype\)begin NS_SWIFT_NAME\(begin\(\)\);/);
  assert.match(header, /- \(NSDictionary<NSString \*, id> \*\)onto:\(NSDictionary<NSString \*, id> \*\)payload NS_SWIFT_NAME\(onto\(_:\)\);/);
  const events = read("../ios/ArdiaEvents.mm");
  assert.match(events, /\+ \(instancetype\)begin \{\s*return \[\[self alloc\] initWithEpoch:ArdiaEvents\.consentEpoch\];/);
  assert.match(events, /stamped\[@"epoch"\] = _epoch;/);
});

test("every native telemetry event JS counts or captures is sent through a consent stamp, never with a hand-written epoch", () => {
  for (const [name, text] of sources()) {
    for (const line of text.split("\n")) {
      const event = STAMPED.find((e) => (line.includes(`@"${e}"`) || line.includes(`emit("${e}"`)) && /emit/.test(line));
      const sent = event && /(?:data|payload):(\w+)\]/.exec(line)?.[1];
      const swiftStamped = /\.onto\(/.test(line);
      const stampedBefore = sent && new RegExp(`\\b${sent} = [^;]*onto:`).test(text);
      if (event) assert.ok(/onto:/.test(line) || swiftStamped || stampedBefore, `${name}: ${event} is sent without a consent stamp: ${line.trim()}`);
      if (/emit.*@"pictureInPicture"/.test(line) && line.includes("fullScreenSpaces")) assert.match(line, /\[stamp onto:/, `${name}: a shown Picture in Picture window is sent without the stamp taken when it opened`);
    }
    assert.doesNotMatch(text, /@"epoch" :/, `${name} writes an epoch by hand instead of through ArdiaConsentStamp`);
  }
});

test("a lost-hover episode keeps the stamp it opened with, and its close sends that stamp", () => {
  assert.match(read("../ios/ArdiaHoverProbeInternal.h"), /ArdiaConsentStamp \*stamp = nil;/);
  const probe = read("../ios/ArdiaHoverProbe.mm");
  const open = probe.slice(probe.indexOf("void OpenEpisode"), probe.indexOf("void HandleHoverCheck"));
  assert.match(open, /gEpisode\.stamp = stamp;/);
  const close = probe.slice(probe.indexOf("void CloseEpisode"), probe.indexOf("bool Recovered"));
  assert.ok(close.indexOf("ArdiaConsentStamp *stamp = gEpisode.stamp;") < close.indexOf("gEpisode = HoverEpisode{};"), "the stamp is kept before the episode is cleared");
  assert.match(close, /\[ArdiaEvents emit:@"engine\.hoverLost" data:\[stamp onto:payload\]\]/);
  assert.doesNotMatch(close, /ArdiaConsentStamp\.begin/);
});

test("a Picture in Picture window is stamped when the page enters it, and the retries that find its window send that stamp", () => {
  const view = read("../ios/ArdiaWebView+PictureInPicture.mm");
  const changed = view.slice(view.indexOf("didChangePictureInPicture"), view.indexOf("requestsActivation"));
  assert.match(changed, /ArdiaConsentStamp \*stamp = _pictureInPictureRequestStamp \?: ArdiaConsentStamp\.begin;/);
  assert.match(changed, /if \(\[state\[@"active"\] boolValue\]\) _pictureInPictureRequestStamp = nil;/);
  const request = view.slice(view.indexOf("- (void)requestPictureInPictureForClickAt:"), view.indexOf("- (void)awaitPictureInPicture:"));
  assert.ok(request.indexOf("_pictureInPictureRequestStamp = stamp;") > 0, "a requested entry is stamped when the click is verified");
  assert.ok(request.indexOf("ArdiaConsentStamp *stamp = ArdiaConsentStamp.begin;") < request.indexOf("_pictureInPictureRequestStamp = stamp;"));
  assert.ok(request.indexOf("_pictureInPictureRequestStamp = stamp;") < request.indexOf("enterPictureInPictureForClickAt"), "the stamp is taken before the engine is asked to enter");
  assert.match(request, /if \(view && \(!entered \|\| view->_reports\.inPictureInPicture\) && view->_pictureInPictureRequestStamp == stamp\) view->_pictureInPictureRequestStamp = nil;/, "a request that ends without entering, or after its entry used the stamp, leaves no stamp for a later entry");
  const entry = request.slice(request.indexOf("enterPictureInPictureForClickAt"));
  assert.doesNotMatch(entry, /\bcompletion\(/, "every end of the request goes through finish, which clears its stamp");
  assert.match(entry, /awaitPictureInPicture:8 completion:finish\]/);
  assert.match(read("../ios/ArdiaWebViewInternal.h"), /ArdiaConsentStamp \*_pictureInPictureRequestStamp;/);
  assert.match(changed, /ardia_pip::VideoEntered\(self, [^;]*, stamp\)/);
  assert.match(changed, /ardia_pip::DocumentEntered\(self, stamp\)/);
  const pip = read("../ios/ArdiaPictureInPicture.mm");
  assert.match(pip, /bool Attach\(ArdiaWebView \*view, NSString \*host, ArdiaConsentStamp \*stamp\)/);
  assert.match(pip, /Attach\(strongView, host, stamp\)/);
  assert.match(pip, /void DocumentEntered\(ArdiaWebView \*view, ArdiaConsentStamp \*stamp\)/);
  assert.doesNotMatch(pip, /ArdiaConsentStamp\.begin/);
  assert.match(read("../ios/ArdiaPictureInPicture.h"), /void VideoEntered\(ArdiaWebView \*view, NSString \*host, ArdiaConsentStamp \*stamp\);/);
});

test("a Picture in Picture drag is stamped when it begins and its report sends that stamp", () => {
  assert.match(read("../ios/ArdiaPictureInPictureInternal.h"), /ArdiaConsentStamp \*_dragStamp;/);
  const swipe = read("../ios/ArdiaPiPController+Swipe.mm");
  const began = swipe.slice(swipe.indexOf("- (void)dragBegan:"), swipe.indexOf("- (void)dragBegan:") + 900);
  assert.match(began, /_dragStamp = ArdiaConsentStamp\.begin;/);
  assert.match(swipe, /emit:@"pictureInPictureDragged" payload:\[_dragStamp onto:/);
});

test("a click skip sends the stamp taken at mouse-down, and only the keyboard skip takes a fresh one", () => {
  const skip = read("../ios/ArdiaPiPController+Skip.mm");
  assert.match(skip, /- \(BOOL\)skipDraggedBy:\(double\)seconds at:\(NSPoint\)point clickCount:\(NSInteger\)clickCount \{\s*return \[self skipBy:seconds at:point clickCount:clickCount stamp:_dragStamp\];/);
  assert.match(skip, /- \(BOOL\)skipBy:\(double\)seconds at:\(NSPoint\)point clickCount:\(NSInteger\)clickCount \{\s*return \[self skipBy:seconds at:point clickCount:clickCount stamp:ArdiaConsentStamp\.begin\];/);
  assert.match(skip, /emit:@"pictureInPictureSkip" payload:\[stamp onto:/);
  const pip = read("../ios/ArdiaPictureInPicture.mm");
  const up = pip.slice(pip.indexOf("NSEventTypeLeftMouseUp) {"), pip.indexOf("[dragged dragMoved:event]"));
  assert.match(up, /\[dragged skipDraggedBy:gGrabSkip at:gGrabLocal clickCount:gGrabClicks\]/);
  assert.doesNotMatch(up, /skipBy:/);
});

test("a hover-loss episode carries the consent epoch from when its mouse event arrived, taken before the hop to the main queue", () => {
  const probe = readFileSync(new URL("../ios/ArdiaHoverProbe.mm", import.meta.url), "utf8");
  const monitor = probe.slice(probe.indexOf("void StartHoverWatch()"));
  const taken = monitor.indexOf("ArdiaConsentStamp *stamp = [ArdiaConsentStamp begin];");
  assert.ok(taken > 0 && taken < monitor.indexOf("dispatch_async"), "the monitor stamps the event before dispatching it");
  assert.match(monitor, /HandleCoveredClick\(weakBrowser, weakCover, point, stamp\)/);
  assert.match(monitor, /HandleHoverCheck\(weakWindow, point, move \? HoverTrigger::move : HoverTrigger::click, stamp\)/);
  const open = probe.slice(probe.indexOf("void OpenEpisode("), probe.indexOf("void HandleHoverCheck("));
  assert.match(open, /gEpisode\.stamp = stamp;/);
  assert.doesNotMatch(open, /ArdiaConsentStamp\.begin|\[ArdiaConsentStamp begin\]/);
});

test("a freeze record is stamped with the epoch when its capture begins, and the record JS reads carries that stamp", () => {
  const capture = read("../ios/ArdiaFreezeCapture.mm");
  const begin = capture.slice(capture.indexOf("void Begin("), capture.indexOf("void Clear("));
  assert.match(begin, /strlcpy\(c\.consent, ArdiaEvents\.consentEpoch\.UTF8String \?: "", sizeof c\.consent\);/);
  assert.match(capture, /gEmit\(\[\[\[ArdiaConsentStamp alloc\] initWithEpoch:@\(done\.consent\)\] onto:record\]\)/);
  assert.doesNotMatch(capture, /record\[@"epoch"\]/);
});
