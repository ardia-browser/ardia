import XCTest

@testable import ArdiaPluginCore

final class PluginLifecycleTests: XCTestCase {
  let runs = PluginRuns<FakeRun>()
  let lifecycle = PluginLifecycle()
  var spawned: [Int] = []
  var nextRun = 1
  var overlapped = false

  func start(_ name: String, cancelled: @escaping () -> Void = {}) {
    lifecycle.enqueue(name, .start, cancelled: cancelled) { [self] done in
      runs.stopAll(name, graceMs: 0) { [self] in
        if runs.all.contains(where: { $0.name == name && !$0.exited }) { overlapped = true }
        nextRun += 1
        spawned.append(nextRun)
        runs.installed(FakeRun(name, nextRun))
        done()
      }
    }
  }

  func testTwoStartsWaitingOnTheSameRetiringRunNeverOverlap() {
    let old = FakeRun("ai", 1)
    runs.installed(old)
    runs.stopAll("ai", graceMs: 3000) {}
    start("ai")
    start("ai")
    XCTAssertEqual(spawned, [], "both wait for run 1's grace period")
    old.exit(in: runs)
    XCTAssertEqual(spawned, [2], "one start at a time")
    runs.all.first { $0.run == 2 }!.exit(in: runs)
    XCTAssertEqual(spawned, [2, 3])
    XCTAssertFalse(overlapped, "no start ever ran beside a live run")
  }

  func testARemovalCancelsAQueuedStartAndDeletesOnlyAfterTheRunHasStopped() {
    let old = FakeRun("ai", 1)
    runs.installed(old)
    var deleted = false
    var cancelled = false
    lifecycle.enqueue("ai", .stop) { [self] done in runs.stopAll("ai", graceMs: 3000, done: done) }
    start("ai") { cancelled = true }
    lifecycle.enqueue("ai", .remove) { [self] done in
      runs.stopAll("ai", graceMs: 1000) {
        deleted = true
        done()
      }
    }
    XCTAssertTrue(cancelled, "the start queued before the removal never runs")
    XCTAssertFalse(deleted)
    old.exit(in: runs)
    XCTAssertTrue(deleted)
    XCTAssertEqual(spawned, [], "nothing was started under the folder being deleted")
  }

  func testStoppingOneOldRunLeavesANewerQueuedStartInPlace() {
    let old = FakeRun("ai", 1)
    runs.installed(old)
    lifecycle.enqueue("ai", .stop) { [self] done in runs.stopAll("ai", graceMs: 3000, done: done) }
    var cancelled = false
    start("ai") { cancelled = true }
    lifecycle.enqueue("ai", .stopRun) { [self] done in runs.stopAll("ai", onlyRun: 1, graceMs: 0, done: done) }
    XCTAssertFalse(cancelled, "a stale run's cleanup doesn't cancel the re-enable queued before it")
    old.exit(in: runs)
    XCTAssertEqual(spawned, [2])
  }
}
