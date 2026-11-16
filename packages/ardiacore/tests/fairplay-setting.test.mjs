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
