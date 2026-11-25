import XCTest

@testable import ArdiaPluginCore

final class PluginTimerQueueTests: XCTestCase {
  func drain(_ queue: inout PluginTimerQueue, now: UInt64) -> [Double] {
    var fired: [Double] = []
    while let id = queue.popDue(now: now) { fired.append(id) }
    return fired
  }

  func testFiresByDueTimeThenBySchedulingOrder() {
    var queue = PluginTimerQueue()
    XCTAssertTrue(queue.schedule(1, due: 20))
    XCTAssertTrue(queue.schedule(2, due: 0))
    XCTAssertTrue(queue.schedule(3, due: 20))
    XCTAssertTrue(queue.schedule(4, due: 0))
    XCTAssertTrue(queue.schedule(5, due: 10))
    XCTAssertEqual(queue.nextDue(), 0)
    XCTAssertEqual(drain(&queue, now: 0), [2, 4])
    XCTAssertNil(queue.popDue(now: 9))
    XCTAssertEqual(drain(&queue, now: 25), [5, 1, 3])
    XCTAssertEqual(queue.count, 0)
    XCTAssertNil(queue.nextDue())
  }

  func testRefusesPastTenThousandWaitingAndCancelFreesASlot() {
    var queue = PluginTimerQueue()
    for id in 0..<PluginTimerQueue.maxTimers { XCTAssertTrue(queue.schedule(Double(id), due: 1_000)) }
    XCTAssertFalse(queue.schedule(1e9, due: 0))
    XCTAssertEqual(queue.count, PluginTimerQueue.maxTimers)
    XCTAssertTrue(queue.cancel(17))
    XCTAssertFalse(queue.cancel(17))
    XCTAssertTrue(queue.schedule(1e9, due: 0))
    XCTAssertEqual(queue.popDue(now: 0), 1e9)
  }

  func testACancelledTimerNeverFiresAndLeavesNothingStored() {
    var queue = PluginTimerQueue()
    for id in 0..<200_000 {
      XCTAssertTrue(queue.schedule(Double(id), due: UInt64.max / 2))
      XCTAssertTrue(queue.cancel(Double(id)))
    }
    XCTAssertEqual(queue.count, 0)
    XCTAssertLessThanOrEqual(queue.storedSlots, 65)
    XCTAssertNil(queue.nextDue())
    XCTAssertEqual(queue.storedSlots, 0)
  }

  func testReschedulingAnIdReplacesItsEntryWithoutGrowing() {
    var queue = PluginTimerQueue()
    for round in 0..<200_000 { XCTAssertTrue(queue.schedule(7, due: UInt64(1_000 + round))) }
    XCTAssertEqual(queue.count, 1)
    XCTAssertLessThanOrEqual(queue.storedSlots, 66)
    XCTAssertNil(queue.popDue(now: 1_000))
    XCTAssertEqual(queue.popDue(now: UInt64(1_000 + 199_999)), 7)
  }

  func testChurnBesideTenThousandLiveTimersStaysBounded() {
    var queue = PluginTimerQueue()
    for id in 0..<9_999 { XCTAssertTrue(queue.schedule(Double(id), due: 5_000)) }
    for id in 0..<100_000 {
      XCTAssertTrue(queue.schedule(Double(100_000 + id), due: UInt64(10 + id % 7)))
      XCTAssertTrue(queue.cancel(Double(100_000 + id)))
    }
    XCTAssertEqual(queue.count, 9_999)
    XCTAssertLessThanOrEqual(queue.storedSlots, 2 * 9_999 + 64)
    XCTAssertEqual(drain(&queue, now: 4_999), [])
    XCTAssertEqual(drain(&queue, now: 5_000).count, 9_999)
  }
}
