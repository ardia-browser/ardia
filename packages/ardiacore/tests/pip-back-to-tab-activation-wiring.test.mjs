import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const controller = read("../ios/ArdiaPiPController.mm");
const pip = read("../ios/ArdiaPictureInPicture.mm");
const webView = read("../ios/ArdiaWebView+PictureInPicture.mm");
const webKit = read("../ios/WebKitTab+UIDelegate.swift");
const host = read("../ios/ArdiaChromeWindowHost.h");

const body = (source, header) => {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? source.length : end);
};

test("Back to Tab activates the app over the frontmost app, as Chromium does, not with a cooperative request macOS can decline", () => {
  const activate = body(pip, "BOOL ActivateApp(NSString *why)");
  assert.match(activate, /\[NSApp activateIgnoringOtherApps:YES\]/);
  assert.doesNotMatch(activate, /\[NSApp activate\]/);
  const mark = activate.indexOf("MarkBackToTabActivation()");
  assert.ok(mark >= 0 && mark < activate.indexOf("activateIgnoringOtherApps:YES"));
  assert.match(activate, /fromOtherApp = !NSApp\.isActive/);
});

test("every way back to the tab goes through the one activation and says whether another app was in front", () => {
  assert.match(body(controller, "- (void)backToTab {"), /fromOtherApp = ActivateApp\(@"Back to Tab \(menu\)"\);[\s\S]*@"fromOtherApp" : @\(fromOtherApp\)/);
  assert.match(body(pip, "BOOL TabRequestedActivation(ArdiaWebView *view, BOOL *fromOtherApp)"), /if \(window\.hasShadow\) continue;\s*\*fromOtherApp = ActivateApp\(@"Back to Tab \(Chrome's button\)"\);\s*return YES;[\s\S]*return NO;/);
  assert.match(body(pip, "+ (BOOL)activateForPictureInPictureReturn"), /return ActivateApp\(/);
  assert.match(host, /\+ \(BOOL\)activateForPictureInPictureReturn;/);
  assert.match(webView, /backToTab = ardia_pip::TabRequestedActivation\(self, &fromOtherApp\);[\s\S]*@"reason" : backToTab \? @"pictureInPicture" : reason[\s\S]*@"fromOtherApp" : @\(fromOtherApp\)/);
  const webKitBack = body(webKit, "func webViewFullscreenMayReturnToInline");
  assert.match(webKitBack, /ArdiaChromeWindowHost\.activateForPictureInPictureReturn\(\)/);
  assert.doesNotMatch(webKitBack, /NSApp\.activate\(\)/);
  assert.match(webKitBack, /"fromOtherApp": fromOtherApp/);
});

test("an activation that arrives right after Ardia was left gives focus back and doesn't raise a browser window", () => {
  const windows = read("../../shell/ios/WindowManager.swift"), leaving = read("../../shell/ios/LeavingOverPiP.swift");
  assert.match(windows, /if ArdiaChromeWindowHost\.consumePictureInPictureActivation\(\) \{ return \}\s*DispatchQueue\.main\.async \{ \[weak self\] in if self\?\.leaving\.givesFocusBack\(\) != true \{ self\?\.focusBrowserPastPiP\(\) \} \}/,
    "the PiP's own activation is consumed first; once the key window has settled the hand-back is checked, and only then is a browser raised");
  assert.match(leaving, /NSApp\.modalWindow == nil, NSApp\.keyWindow\.map\(\{ isPiP\(\$0\) \|\| !\$0\.isOnActiveSpace \}\) \?\? true/,
    "a click back into a browser window or a dialog is the user's choice: focus is only handed back when the PiP, or nothing on this Space, took the key");
  assert.match(leaving, /resignedActiveAt = ProcessInfo\.processInfo\.systemUptime/);
  assert.match(leaving, /now - resignedActiveAt < LeavingOverPiP\.justNow/);
  assert.match(leaving, /!commandHeldSinceLeaving, !NSEvent\.modifierFlags\.contains\(\.command\)/, "Cmd+Tab back to Ardia is the user's choice and still raises the browser");
  assert.match(leaving, /commandHeldSinceLeaving = false[\s\S]*if NSEvent\.modifierFlags\.contains\(\.command\) \{ self\.commandHeldSinceLeaving = true \}/,
    "Cmd is watched from the moment Ardia is left: the switcher acts when Cmd is released, so it is already up when Ardia becomes active");
  assert.match(leaving, /isOnActiveSpace && isPiP\(\$0\)/);
  assert.match(leaving, /guard let app = appLeftFor, !app\.isTerminated else \{ return false \}/, "with no app to go back to (it quit), Ardia keeps the activation and the browser is raised as before");
  assert.match(leaving, /if !again \{\s*if #available\(macOS 14\.0, \*\) \{ app\.activate\(from: \.current, options: \[\]\) \}/, "a second hand-back in a row is not repeated, so two apps can't trade focus forever");
  assert.match(leaving, /"type": "pipActivationHandBack", "again": again/);
  assert.match(leaving, /static let justNow = 1\.0/);
});

test("a press on the PiP activates with only that window, and never falls back to an activation that could raise a browser window", () => {
  const start = pip.indexOf("void ActivateWithOnlyPictureInPicture("), activation = pip.slice(start, pip.indexOf("BOOL ActivateApp(NSString *why)", start));
  assert.ok(start >= 0 && activation.length > 0);
  assert.match(activation, /dlsym\(RTLD_DEFAULT, "_SLPSSetFrontProcessWithOptions"\)/);
  assert.doesNotMatch(activation, /activateIgnoringOtherApps|\[NSApp activate\]/, "the ordinary activation brings the main window forward too");
  assert.match(activation, /!= kCGErrorSuccess\) \{\s*ConsumeBackToTabActivation\(\);\s*return EndActiveOnlyForPictureInPicture\(\);/, "a refused activation leaves no mark behind for a later one");
});

