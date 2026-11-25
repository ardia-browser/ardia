import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/shell/ios/FullScreenLifecycle.swift");
const swiftc = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;

const MAIN = `
import AppKit
_ = NSApplication.shared
let center = NotificationCenter.default
func spin(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
func lifecycle() -> FullScreenLifecycle {
  let l = FullScreenLifecycle()
  l.timing = .init(settleCheckAfter: 0.3, checkEvery: 0.1, giveUpAfter: 1.0)
  l.start()
  return l
}
var out: [String: Any] = [:]

do {
  let l = lifecycle()
  let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
  var state = false
  l.stateOf = { _ in state }
  center.post(name: NSWindow.willEnterFullScreenNotification, object: window)
  state = true
  spin(0.2)
  out["stableBeforeCheck"] = l.isUnresolved(window)
  spin(0.4)
  out["stableAfterChecks"] = l.isUnresolved(window)
}

do {
  let l = lifecycle()
  var logged: [String] = []
  l.log = { logged.append($0) }
  let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
  var flips = false
  l.stateOf = { _ in flips.toggle(); return flips }
  center.post(name: NSWindow.willEnterFullScreenNotification, object: window)
  spin(0.8)
  out["flappingAt0_8"] = l.isUnresolved(window)
  spin(0.5)
  out["flappingAt1_3"] = l.isUnresolved(window)
  out["gaveUpLogged"] = logged.count
}

do {
  let l = lifecycle()
  let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
  var state = true
  l.stateOf = { _ in state }
  let before = l.latestGeneration
  var settled = 0
  _ = l.waitForTransition(of: window, startedAfter: before) { settled += 1 }
  center.post(name: NSWindow.willExitFullScreenNotification, object: window)
  center.post(name: NSNotification.Name("ArdiaWindowDidFailToExitFullScreen"), object: window)
  spin(0.05)
  out["exitAfterFailureCallback"] = l.isUnresolved(window)
  state = false
  center.post(name: NSWindow.didExitFullScreenNotification, object: window)
  spin(0.05)
  out["exitAfterDidExit"] = l.isUnresolved(window)
  out["exitSettled"] = settled

  var late = 0
  center.post(name: NSWindow.willEnterFullScreenNotification, object: window)
  _ = l.waitForTransition(of: window, startedAfter: l.latestGeneration) { late += 1 }
  center.post(name: NSWindow.didEnterFullScreenNotification, object: window)
  spin(0.05)
  out["olderTransitionSettledNewerCall"] = late
}

do {
  let l = lifecycle()
  let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
  var state = true
  var recorded: [Bool] = []
  l.stateOf = { _ in state }
  l.settledByCheck = { _, on in recorded.append(on) }
  center.post(name: NSWindow.willExitFullScreenNotification, object: window)
  state = false
  spin(0.6)
  out["exitWithoutDidExitCleared"] = !l.isUnresolved(window)
  out["exitRecorded"] = recorded
}

do {
  let l = lifecycle()
  var logged: [String] = []
  l.log = { logged.append($0) }
  let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
  var state = false
  l.stateOf = { _ in state }
  center.post(name: NSWindow.willEnterFullScreenNotification, object: window)
  state = true
  spin(0.6)
  let before = l.latestGeneration
  var settled = 0
  _ = l.waitForTransition(of: window, startedAfter: before) { settled += 1 }
  center.post(name: NSWindow.willExitFullScreenNotification, object: window)
  center.post(name: NSWindow.didEnterFullScreenNotification, object: window)
  spin(0.05)
  out["lateDidEnterEndedExit"] = !l.isUnresolved(window)
  out["lateDidEnterSettled"] = settled
  out["staleLogged"] = logged.filter { $0.contains("stale") }.count
  state = false
  center.post(name: NSWindow.didExitFullScreenNotification, object: window)
  spin(0.05)
  out["realDidExitEnded"] = !l.isUnresolved(window)
  out["realDidExitSettled"] = settled
}

do {
  let l = lifecycle()
  let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
  var state = true
  l.stateOf = { _ in state }
  var settled = 0
  _ = l.waitForTransition(of: window, startedAfter: l.latestGeneration) { settled += 1 }
  center.post(name: NSWindow.willExitFullScreenNotification, object: window)
  state = false
  out["windowManagerWouldRecordLateEnter"] = l.acceptsEnd(of: window, entering: true)
  center.post(name: NSWindow.didEnterFullScreenNotification, object: window)
  spin(0.05)
  out["lateEnterEndedExitWithStateOut"] = !l.isUnresolved(window)
  out["lateEnterSettledExit"] = settled
  out["windowManagerRecordsRealExit"] = l.acceptsEnd(of: window, entering: false)
  center.post(name: NSWindow.didExitFullScreenNotification, object: window)
  spin(0.05)
  out["didExitEndedIt"] = !l.isUnresolved(window)
  out["didExitSettled"] = settled
}

print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
`;

test("full screen: a transition with no end clears on its real state and records it, gives up at the limit, an exit failure waits for didExit, and a late or stale end never answers a newer call", { skip: !swiftc && "needs swiftc" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "full-screen-lifecycle-"));
  try {
    writeFileSync(join(dir, "main.swift"), MAIN);
    execFileSync("xcrun", ["swiftc", source, join(dir, "main.swift"), "-o", join(dir, "run")], { stdio: "pipe" });
    const got = JSON.parse(execFileSync(join(dir, "run"), { encoding: "utf8", timeout: 30_000 }).trim());
    assert.equal(got.stableBeforeCheck, true, "nothing clears before the timeout");
    assert.equal(got.stableAfterChecks, false, "a steady real state clears it");
    assert.equal(got.flappingAt0_8, true, "a state that keeps changing isn't settled");
    assert.equal(got.flappingAt1_3, false, "the bounded check gives up at its limit");
    assert.equal(got.gaveUpLogged, 1, "and logs that it did");
    assert.equal(got.exitAfterFailureCallback, true, "Chromium's exit-failure callback doesn't end the transition");
    assert.equal(got.exitAfterDidExit, false);
    assert.equal(got.exitSettled, 1);
    assert.equal(got.olderTransitionSettledNewerCall, 0, "a transition that began before the call doesn't answer it");
    assert.equal(got.exitWithoutDidExitCleared, true, "an exit with no didExit clears on the real state");
    assert.deepEqual(got.exitRecorded, [false], "and records that real state for geometry");
    assert.equal(got.lateDidEnterEndedExit, false, "a late didEnter doesn't end a newer exit");
    assert.equal(got.lateDidEnterSettled, 0);
    assert.equal(got.staleLogged, 1, "the stale notification is logged");
    assert.deepEqual([got.realDidExitEnded, got.realDidExitSettled], [true, 1]);
    assert.equal(got.lateEnterEndedExitWithStateOut, false, "a late didEnter doesn't finish an exit, even with the window already out of full screen");
    assert.equal(got.lateEnterSettledExit, 0);
    assert.equal(got.windowManagerWouldRecordLateEnter, false, "WindowManager's cached flag takes the same decision");
    assert.equal(got.windowManagerRecordsRealExit, true);
    assert.deepEqual([got.didExitEndedIt, got.didExitSettled], [true, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
