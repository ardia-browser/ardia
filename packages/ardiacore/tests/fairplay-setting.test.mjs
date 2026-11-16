import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const fairPlay = read("../ios/ArdiaFairPlay.mm");
const messages = read("../ios/ArdiaWebView+PageMessages.mm");
const module = read("../ios/WebViewModule.swift");
const pageScript = read("../ios/page_script.js");
const engines = read("../../../apps/browser/src/state/engines/engines.ts");
const nativeSettings = read("../../../apps/browser/src/state/settings/nativeSettings.ts");
const settings = read("../../../apps/browser/src/state/settings/settings.ts");
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${start} not found`);
  return text.slice(from, text.indexOf(end, from + start.length));
};
const quoted = (text, pattern) => {
  const found = text.match(pattern);
  assert.ok(found, `${pattern} not found`);
  return [...found[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
};

test("the app, the native side and the page script name the same FairPlay sites, each an exact https origin", () => {
  const app = quoted(engines, /export const FAIRPLAY_IN_CHROMIUM_ORIGINS: readonly string\[\] = \[([^\]]*)\]/);
  const native = quoted(fairPlay, /NSSet<NSString \*> \*FairPlayOrigins\(\) \{\n {2}static NSSet<NSString \*> \*origins = \[NSSet setWithArray:@\[([^\]]*)\]\];/);
  const page = quoted(pageScript, /const FAIRPLAY_ORIGINS = \[([^\]]*)\];/);
  assert.ok(app.length > 0);
  assert.deepEqual(native, app);
  assert.deepEqual(page, app);
  for (const origin of app) assert.equal(new URL(origin).origin, origin);
  assert.match(fairPlay, /\+ \(BOOL\)servesOrigin:\(NSString \*\)origin \{\n {2}return origin && \[FairPlayOrigins\(\) containsObject:origin\];\n\}/);
  assert.match(pageScript, /isTop && FAIRPLAY_ORIGINS\.includes\(location\.origin\)/);
});

test("FairPlay in Chromium is off until the app's setting turns it on", () => {
  assert.match(fairPlay, /^BOOL gEnabled = NO;$/m);
  assert.match(settings, /fairPlayInChromium: flag\(false\),/);
  assert.match(nativeSettings, /mirror\("fairPlayInChromium", setFairPlayInChromium\)/);
  assert.match(module, /"setFairPlayInChromium": setting \{ ArdiaWebView\.setFairPlayInChromium\(try \$0\.bool\("enabled"\)\) \}/);
});

test("a FairPlay site's page is offered FairPlay only while the setting is on and the helper is in the app", () => {
  assert.match(messages, /JSONText\(@\{@"event" : @"config", @"on" : @\(ArdiaFairPlay\.enabled && ArdiaFairPlay\.available\)\}\)/);
  assert.match(messages, /\[tab callFrame:frameId kind:@"fairPlay" json:FairPlayConfig\(\)\]/);
});

test("changing the setting tells pages already open on a FairPlay site, so they need no reload", () => {
  const setter = between(messages, "+ (void)setFairPlayInChromium:(BOOL)enabled {", "\n}\n");
  assert.match(setter, /if \(enabled == ArdiaFairPlay\.enabled\) return;\n {2}ArdiaFairPlay\.enabled = enabled;\n {2}for \(ArdiaWebView \*view in LiveViews\(\)\.allObjects\) \[view pushFairPlay\];/);
  assert.match(messages, /- \(void\)pushFairPlay \{\n {2}if \(_tab && \[ArdiaFairPlay servesOrigin:OriginOf\(_tab\.url\)\]\) \[_tab callPage:@"fairPlay" json:FairPlayConfig\(\)\];\n\}/);
  assert.match(pageScript, /if \(m\.event === "config"\) return configureFairPlay\(m\.on === true\);/);
});

test("while off, a page's FairPlay messages never reach the helper, and a load is answered as a failed player", () => {
  const entry = between(fairPlay, "+ (void)tab:(ArdiaCoreTab *)tab frame:", "\n}\n");
  assert.match(entry, /if \(gEnabled\) return \[self\.shared tab:tab frame:frameId message:message\];/);
  assert.equal(entry.match(/\[self\.shared /g).length, 2);
  assert.match(entry, /isEqualToString:@"load"\]/);
  assert.match(entry, /WholeNumber\(message, @"part", 0, 0, &part\)/);
  assert.match(entry, /deliver:@\{@"event" : @"failed", @"gen" : @\(generation\), @"step" : @"player"\} to:tab frame:frameId/);
});

test("turning it off stops the playing track: the page hears it was taken away and the helper stops", () => {
  const setter = between(fairPlay, "+ (void)setEnabled:(BOOL)enabled {", "\n}\n");
  assert.match(setter, /if \(enabled == gEnabled\) return;\n {2}gEnabled = enabled;\n {2}if \(enabled\) return;/);
  assert.match(setter, /deliver:@\{@"event" : @"stolen", @"gen" : @\(shared->_generation\)\} to:owner frame:shared->_frame\]/);
  assert.ok(setter.trimEnd().endsWith("[shared stop];"));
});

const protectedVideo = read("../ios/ArdiaProtectedVideo.mm");
const protectedVideoParts = read("../ios/ArdiaProtectedVideoInternal.h");
const hostEngine = read("../ios/ArdiaHostEngineDelegate.mm");
const embed = read("../scripts/embed.sh");
const extensionRules = JSON.parse(read("../extensions/protected-video-ua/rules.json"));

test("the protected video sites are FairPlay sites, named the same by the native side and the page script", () => {
  const native = quoted(between(protectedVideo, "NSSet<NSString *> *ProtectedVideoOrigins() {", "\n}\n"), /\[NSMutableSet setWithArray:@\[([^\]]*)\]\];/);
  const page = quoted(pageScript, /const PROTECTED_VIDEO_ORIGINS = \[([^\]]*)\];/);
  const fairPlaySites = quoted(engines, /export const FAIRPLAY_IN_CHROMIUM_ORIGINS: readonly string\[\] = \[([^\]]*)\]/);
  assert.deepEqual(native, ["https://www.netflix.com", "https://www.disneyplus.com"]);
  assert.deepEqual(page, native);
  for (const origin of native) assert.ok(fairPlaySites.includes(origin), origin);
  assert.match(pageScript, /isTop && FAIRPLAY_ORIGINS\.includes\(location\.origin\) && !PROTECTED_VIDEO_ORIGINS\.includes\(location\.origin\)/);
  assert.match(pageScript, /isTop && PROTECTED_VIDEO_ON && PROTECTED_VIDEO_ORIGINS\.includes\(location\.origin\)/);
});

test("protected video is baked out of the page script until the setting turns it on", () => {
  assert.equal(pageScript.split("const PROTECTED_VIDEO_ON = false;").length, 2);
  assert.ok(!pageScript.includes("const PROTECTED_VIDEO_ON = true;"));
  assert.match(protectedVideo, /^BOOL gEnabled = NO;$/m);
  assert.match(protectedVideo, /kScriptOff = @"const PROTECTED_VIDEO_ON = false;"/);
  assert.match(protectedVideo, /kScriptOn = @"const PROTECTED_VIDEO_ON = true;"/);
  assert.match(hostEngine, /engine\.pageScript = \[ArdiaProtectedVideo pageScriptFrom:script\];/);
  const setter = between(messages, "+ (void)setFairPlayInChromium:(BOOL)enabled {", "\n}\n");
  assert.match(setter, /ArdiaProtectedVideo\.enabled = enabled;/);
  const entry = between(protectedVideo, "+ (void)tab:(ArdiaCoreTab *)tab frame:", "\n}\n");
  assert.match(entry, /if \(!gEnabled \|\| !frameId\.length\) return;/);
  assert.match(messages, /\[kind isEqualToString:@"protectedVideo"\] && main && dict && \[ArdiaProtectedVideo servesOrigin:VerifiedOrigin\(verifiedOrigin\)\]/);
});

test("a page that started with the bridge baked the other way is reloaded once the setting is known", () => {
  assert.match(pageScript, /send\("hello", \{ top: isTop, url: location\.href, protectedVideo: PROTECTED_VIDEO_ON, started: performance\.timeOrigin \}\);/);
  assert.match(messages, /\[ArdiaProtectedVideo helloFromTab:tab origin:VerifiedOrigin\(verifiedOrigin\) bridged:Flag\(dict, @"protectedVideo"\) started:Finite\(dict, @"started", &startedMs\) \? startedMs \/ 1000 : 0\];/);
  const hello = between(protectedVideo, "+ (void)helloFromTab:(ArdiaCoreTab *)tab origin:", "\n}\n");
  assert.match(hello, /if \(!tab \|\| !\[self servesOrigin:origin\]\) return;/);
  assert.match(hello, /if \(bridged == gEnabled && !settled\) return;/);
  assert.match(hello, /-last\.timeIntervalSinceNow < kReloadGap\) return;/);
  assert.match(hello, /\[OriginOf\(current\.url\) isEqualToString:origin\]\) \[current reload\];/);
});

test("a Netflix page that loaded before the user agent rules took hold is reloaded after they settle", () => {
  assert.match(protectedVideo, /kUserAgentRuleOrigin = @"https:\/\/www\.netflix\.com";/);
  const ruleHosts = JSON.parse(read("../extensions/protected-video-ua/rules.json"))[0].condition.requestDomains;
  assert.ok(ruleHosts.includes("netflix.com"));
  const load = between(protectedVideo, "+ (void)loadIntoProfile:(ArdiaCoreProfile *)profile {", "\n}\n");
  assert.match(load, /\[self\.extensionLoads setObject:NSDate\.date forKey:profile\];/);
  const settle = between(protectedVideo, "+ (NSTimeInterval)rulesSettleForTab:", "\n}\n");
  assert.match(settle, /if \(!gEnabled \|\| started <= 0 \|\| !\[origin isEqualToString:kUserAgentRuleOrigin\]\) return 0;/);
  assert.match(settle, /loaded\.timeIntervalSince1970 \+ kRulesSettle/);
  assert.match(settle, /return loaded && started < settled \? settled : 0;/);
});
test("the local test origin is honoured only from a test instance, only on 127.0.0.1, and is spliced into the baked origins", () => {
  const launchConfig = read("../ios/ArdiaLaunchConfig.mm");
  assert.match(between(launchConfig, "NSArray<NSString *> *AppTestKeys() {", "\n}\n"), /@"protectedVideoOrigin"/);
  assert.match(protectedVideo, /\[ArdiaLaunchConfig\.shared testValue:@"protectedVideoOrigin"\]/);
  assert.match(protectedVideo, /kTestOriginPrefix = @"http:\/\/127\.0\.0\.1:"/);
  const line = protectedVideo.match(/kOriginsOff = @"(.*)";/)[1].replaceAll('\\"', '"');
  assert.equal(pageScript.split(line).length, 2);
  assert.match(between(protectedVideo, "+ (NSString *)bakedScript {", "\n}\n"), /if \(!gEnabled\) return gOriginalScript;/);
});

const sessionCore = read("../ios/ArdiaPVSession.mm");
const playback = read("../ios/ArdiaPVSession+Playback.mm");
const pictureInPicture = read("../ios/ArdiaPVSession+PictureInPicture.mm");
const keys = read("../ios/ArdiaPVSession+Keys.mm");
const media = read("../ios/ArdiaProtectedVideoMedia.mm");
const podspec = read("../ios/ArdiaCore.podspec");

test("protected video is parsed into sample buffers and rendered on one synchronizer, with no local HLS server", () => {
  assert.throws(() => read("../ios/ArdiaPVSession+Server.mm"), /ENOENT/);
  assert.doesNotMatch(protectedVideoParts, /nw_listener_t|AVPlayer \*|m3u8/);
  assert.doesNotMatch(podspec, /'Network'/);
  assert.match(media, /_parser = \[NSClassFromString\(@"AVStreamDataParser"\) new\];/);
  assert.match(media, /\[_parser appendStreamData:unit\];\n {2}\[_parser providePendingMediaData\];/);
  const renderers = between(playback, "- (void)setUpRenderers {", "\n}\n");
  assert.match(renderers, /\[_sync addRenderer:_display\];\n {2}\[_sync addRenderer:_audio\];/);
  assert.match(renderers, /_display\.backgroundColor = NSColor\.blackColor\.CGColor;/);
  assert.match(between(playback, "- (double)position {", "\n}\n"), /CMTimeGetSeconds\(_sync\.currentTime\)/);
});

test("samples are enqueued only while a renderer asks for more, and a rendition switch is just the next sample's format", () => {
  const feed = between(playback, "- (void)feed:(ArdiaPVLane *)lane {", "\n}\n");
  assert.match(feed, /requestMediaDataWhenReadyOnQueue:dispatch_get_main_queue\(\)/);
  const pump = between(playback, "- (void)pump:(ArdiaPVLane *)lane {", "\n}\n");
  assert.match(pump, /while \(lane->_requesting && lane->_renderer\.readyForMoreMediaData\)/);
  assert.match(pump, /ArdiaPVSegment \*next = \[lane following:segment\];/);
  const append = between(sessionCore, "- (void)append:(NSDictionary *)message {", "\n}\n");
  assert.match(append, /if \(\[track->_init isEqualToData:unit\]\) return;/);
  assert.doesNotMatch(append, /DISCONTINUITY|stopRun|restart/);
});

test("a seek inside stored media keeps the last picture and hides the frames decoded before the target", () => {
  const halt = between(playback, "- (void)halt:(ArdiaPVLane *)lane {", "\n}\n");
  assert.match(halt, /flushWithRemovalOfDisplayedImage:NO/);
  assert.match(between(playback, "- (void)pump:(ArdiaPVLane *)lane {", "\n}\n"), /if \(EndOf\(sample\) <= lane->_from \+ 1e-4\) \{\n {6}if \(!lane->_video\) continue;\n {6}hidden = HiddenCopy\(sample\);/);
  assert.match(media, /kCMSampleAttachmentKey_DoNotDisplay, kCFBooleanTrue/);
  const cue = between(media, "- (void)cueAt:(double)time {", "\n}\n");
  assert.match(cue, /IsSync\(sample\) && StartOf\(sample\) <= time \+ 1e-4/);
  const seek = between(playback, "- (void)seekTo:(double)time {", "\n}\n");
  assert.match(seek, /if \(\[self canStartAt:time\]\) return \[self startAt:time\];/);
  assert.match(seek, /_pendingTarget = time;/);
});

test("encrypted samples wait for their licensed key, which reaches the renderers as key recipients", () => {
  const pump = between(playback, "- (void)pump:(ArdiaPVLane *)lane {", "\n}\n");
  assert.match(pump, /id key = segment->_kid \? _contentKeys\[segment->_kid\] : nil;/);
  assert.match(pump, /lane->_blocked = YES;\n {6}return \[self idle:lane\];/);
  assert.doesNotMatch(pump, /AVSampleBufferAttachContentKey/);
  assert.match(playback, /\[self addRenderersAsKeyRecipients\];/);
  const succeeded = between(keys, "contentKeyRequestDidSucceed:(AVContentKeyRequest *)keyRequest {", "\n}\n");
  assert.match(succeeded, /self->_contentKeys\[kid\] = contentKey \?: \(id\)NSNull\.null;\n {6}\[self keysChanged\];/);
  assert.match(between(keys, "- (void)addRenderersAsKeyRecipients {", "\n}\n"), /\[_keys addContentKeyRecipient:renderer\]/);
  assert.match(keys, /processContentKeyRequestWithIdentifier:nil initializationData:/);
});

test("the page tells the native side the MediaSource duration whenever it changes", () => {
  const send = between(pageScript, "const sendDuration = (b) => {", "\n      };\n");
  assert.match(send, /const known = isFinite\(duration\) && duration > 0 \? duration : 0;\n {8}if \(known === b\.sentDuration\) return;/);
  assert.match(send, /sendMedia\(b, \{ op: "duration", media: b\.id, duration: known \}\);/);
  assert.match(between(pageScript, "const progress = (b) => {", "\n      };\n"), /sendDuration\(b\);/);
  assert.match(between(pageScript, "SourceProto.endOfStream = asNative(", "\n      });\n"), /sendDuration\(b\);/);
  assert.match(pageScript, /defineProperty\(SourceProto, "duration", \{[\s\S]{0,300}if \(b && bridgeOf\.get\(b\.el\) === b\) sendDuration\(b\);/);
  assert.match(sessionCore, /if \(!Bounded\(message, @"duration", 0, 1e8, &duration\) \|\| duration == _duration\) return;/);
});

test("a video given a source while the playing one plays is held, its messages kept, until the page plays it or the playing one lets go", () => {
  assert.match(pageScript, /const sendMedia = \(b, data\) => \(b\.held \? b\.backlog\.push\(data\) : send\("protectedVideo", data\)\);/);
  const bridgeCode = between(pageScript, "const bridge = (el, source) => {", "\n      };\n");
  assert.match(bridgeCode, /const hold = !!\(bridged && bridged\.played && !bridged\.ended && bridged\.el !== el\);/);
  assert.match(bridgeCode, /if \(bridged && !hold\) release\(bridged\.el\);/);
  assert.match(bridgeCode, /if \(hold\) held = b;\n {8}else bridged = b;/);
  const releaseCode = between(pageScript, "const release = (el) => {\n        const b = bridgeOf.get(el);", "\n      };\n");
  assert.match(releaseCode, /if \(bridged === b\) \{\n {10}bridged = null;\n {10}if \(held\) takeOver\(held\);/);
  const takeOverCode = between(pageScript, "const takeOver = (b) => {", "\n      };\n");
  assert.match(takeOverCode, /if \(bridged && bridged !== b\) release\(bridged\.el\);[\s\S]*for \(const data of b\.backlog\.splice\(0\)\) send\("protectedVideo", data\);/);
  assert.match(between(pageScript, 'method(Media, "play", (b, el) => {', "\n      });\n"), /b\.played = true;\n {8}if \(b\.held\) takeOver\(b\);/);
  const shim = pageScript.slice(pageScript.indexOf("let bridged = null;"), pageScript.indexOf('method(Video, "requestPictureInPicture"'));
  assert.doesNotMatch(shim.replace('send("protectedVideo", data)', "").replace('send("protectedVideo", data);', ""), /send\("protectedVideo"/);
});

test("a picture in picture deadline only acts for the request that set it", () => {
  const start = between(pictureInPicture, "- (BOOL)startPictureInPicture {", "\n}\n");
  assert.match(start, /const NSInteger request = \+\+_pipRequest;/);
  assert.match(start, /session->_pipRequest != request \|\| !session->_pipWanted/);
  const exit = between(pictureInPicture, "- (void)exitPictureInPicture {", "\n}\n");
  assert.match(exit, /const NSInteger request = \+\+_pipRequest;/);
  assert.match(exit, /session->_pipRequest != request \|\| !session->_inPip/);
  assert.match(between(pictureInPicture, "pictureInPictureControllerDidStartPictureInPicture:", "\n}\n"), /_pipRequest\+\+;/);
});

test("picture in picture runs on the sample buffer layer, and its skip and play buttons reach the page as real events", () => {
  assert.match(pictureInPicture, /initWithSampleBufferDisplayLayer:_display/);
  assert.match(pictureInPicture, /addObserver:self forKeyPath:@"pictureInPicturePossible"/);
  assert.doesNotMatch(pictureInPicture, /300 \* NSEC_PER_MSEC/);
  assert.match(between(pictureInPicture, "skipByInterval:(CMTime)skipInterval", "\n}\n"), /@"event" : @"seekBy", @"media" : @\(_media\), @"delta" : @\(delta\)/);
  assert.match(between(pictureInPicture, "setPlaying:(BOOL)playing {", "\n}\n"), /@"event" : @"paused", @"media" : @\(_media\), @"paused" : @\(!playing\)/);
  assert.match(between(pictureInPicture, "pictureInPictureControllerTimeRangeForPlayback:", "\n}\n"), /_duration > 0 \? _duration : \[self bufferedEnd\]/);
  assert.match(pageScript, /m\.event === "seekBy"\) \{\n {10}if \(typeof m\.delta === "number" && isFinite\(m\.delta\) && b\.metadata\) b\.el\.currentTime = positionOf\(b\) \+ m\.delta;/);
});
test("the user agent extension only gives Netflix and YouTube Safari's face, and ships in the app", () => {
  assert.equal(extensionRules.length, 1);
  assert.deepEqual(extensionRules[0].condition.requestDomains, ["netflix.com", "www.youtube.com"]);
  assert.ok(extensionRules[0].condition.resourceTypes.includes("main_frame"));
  const agent = extensionRules[0].action.requestHeaders.find((h) => h.header === "user-agent");
  assert.ok(pageScript.includes(`const SAFARI_UA = "${agent.value}";`));
  assert.match(embed, /rsync -a --delete "\$repo\/packages\/ardiacore\/extensions\/protected-video-ua\/" "\$extensions\/protected-video-ua\/"/);
  assert.match(protectedVideo, /kExtensionName = @"protected-video-ua"/);
});

test("a licence for a closed HLS key session is dropped, not read from a missing session", () => {
  const hlsKeys = read("../ios/ArdiaHLSVideoSession+Keys.mm");
  const update = between(hlsKeys, "- (void)updateKeySession:(NSInteger)session data:(NSData *)data {", "\n}\n");
  assert.ok(update.indexOf("if (!owner) return;") >= 0 && update.indexOf("if (!owner) return;") < update.indexOf("owner->_awaiting"));
  assert.match(pageScript, /if \(keySessions\.has\(id\)\) send\("hlsVideo", \{ op: "update", session: id, data: toBase64\(bytes\) \}\);/);
});

test("a raw FairPlay key session has one licence request out at a time, and its licence goes to that request", () => {
  const keys = read("../ios/ArdiaPVSession+Keys.mm");
  const update = between(keys, "- (void)keyUpdate:(NSDictionary *)message session:(NSInteger)session {", "\n}\n");
  assert.match(update, /NSData \*kid = owner->_awaitingKid;/);
  assert.match(update, /AVContentKeyRequest \*request = kid \? _keyRequests\[kid\] : nil;/);
  assert.match(update, /return \[self askPageForNextRawKey:session\];/);
  assert.doesNotMatch(update, /_keyRequests\.allKeys/);
  const ask = between(keys, "- (void)askPage:(NSInteger)session for:", "\n}\n");
  assert.match(ask, /\[owner->_rawQueue addObjectsFromArray:entries\];/);
  const next = between(keys, "- (void)askPageForNextRawKey:(NSInteger)session {", "\n}\n");
  assert.match(next, /while \(owner && !owner->_awaitingKid && owner->_rawQueue\.count\)/);
  assert.match(next, /owner->_awaitingKid = entry\[@"keyID"\];/);
  const failed = between(keys, "contentKeyRequest:(AVContentKeyRequest *)keyRequest didFailWithError:", "\n}\n");
  assert.match(failed, /keySession->_raw && \[keySession->_awaitingKid isEqualToData:kid\]/);
});
