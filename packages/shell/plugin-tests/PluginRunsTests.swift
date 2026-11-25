import XCTest

@testable import ArdiaPluginCore

final class FakeRun: PluginRun {
  let name: String
  let run: Int
  var exited = false
  var stopRequests = 0
  private var waiters: [() -> Void] = []

  init(_ name: String, _ run: Int) {
    self.name = name
    self.run = run
  }

  func stop(graceMs: Int, done: @escaping () -> Void) {
    stopRequests += 1
    if exited { return done() }
    waiters.append(done)
  }

  func exit(in runs: PluginRuns<FakeRun>) {
    exited = true
    runs.exited(self)
    let pending = waiters
    waiters = []
    pending.forEach { $0() }
  }
}

final class PluginRunsTests: XCTestCase {
  func testASecondStopWaitsForTheRunTheFirstIsStillStopping() {
    let runs = PluginRuns<FakeRun>()
    let first = FakeRun("ai", 1)
    runs.installed(first)
    var firstDone = false
    var secondDone = false
    runs.stopAll("ai", graceMs: 3000) { firstDone = true }
    runs.stopAll("ai", graceMs: 3000) { secondDone = true }
    XCTAssertFalse(secondDone, "nothing is current, but run 1 is still in its grace period")
    first.exit(in: runs)
    XCTAssertTrue(firstDone)
    XCTAssertTrue(secondDone)
  }

  func testStoppingOneRunLeavesTheOthersAlone() {
    let runs = PluginRuns<FakeRun>()
    let old = FakeRun("ai", 1)
    runs.installed(old)
    runs.stopAll("ai", graceMs: 3000) {}
    let fresh = FakeRun("ai", 2)
    runs.installed(fresh)
    var done = false
    runs.stopAll("ai", onlyRun: 2, graceMs: 0) { done = true }
    XCTAssertEqual(old.stopRequests, 1)
    fresh.exit(in: runs)
    XCTAssertTrue(done)
    XCTAssertEqual(runs.all.map(\.run), [1])
  }
}
