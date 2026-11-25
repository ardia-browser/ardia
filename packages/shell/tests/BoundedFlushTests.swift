import Foundation
import XCTest
@testable import ArdiaUpdaterCore

final class BoundedFlushTests: XCTestCase {
  func testCompletesBeforeTimeoutAndRunsWork() {
    let queue = DispatchQueue(label: "test.bounded-flush.ok")
    var ran = false
    let finished = BoundedFlush.run(on: queue, timeout: 1) { remaining in
      XCTAssertTrue(remaining())
      ran = true
    }
    XCTAssertTrue(finished)
    XCTAssertTrue(ran)
  }

  func testReturnsFalseWhenPriorTaskStallsQueueAndSkipsLateWork() {
    let queue = DispatchQueue(label: "test.bounded-flush.prior-stall")
    let started = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    queue.async {
      started.signal()
      release.wait()
    }
    XCTAssertEqual(started.wait(timeout: .now() + 1), .success)

    var workRan = false
    let start = Date()
    let finished = BoundedFlush.run(on: queue, timeout: 0.08) { remaining in
      if remaining() { workRan = true }
    }
    let elapsed = Date().timeIntervalSince(start)

    XCTAssertFalse(finished)
    XCTAssertLessThan(elapsed, 0.5)

    release.signal()
    queue.sync {}
    XCTAssertFalse(workRan)
  }

  func testReturnsFalseWhenWorkItselfStalls() {
    let queue = DispatchQueue(label: "test.bounded-flush.work-stall")
    let release = DispatchSemaphore(value: 0)
    var secondStepRan = false

    let start = Date()
    let finished = BoundedFlush.run(on: queue, timeout: 0.08) { remaining in
      release.wait()
      if remaining() { secondStepRan = true }
    }
    let elapsed = Date().timeIntervalSince(start)

    XCTAssertFalse(finished)
    XCTAssertLessThan(elapsed, 0.5)

    release.signal()
    queue.sync {}
    XCTAssertFalse(secondStepRan)
  }
}
