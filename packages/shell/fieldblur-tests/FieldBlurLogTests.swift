import XCTest
@testable import ArdiaFieldBlurCore

final class FieldBlurLogTests: XCTestCase {
  private let alive: () -> Bool = { true }

  private func log(watching fields: Int..., cap: Int = FieldBlurLog.defaultCap) -> FieldBlurLog {
    let log = FieldBlurLog(cap: cap)
    for field in fields { log.watch(field: field) }
    return log
  }

  func testEachBlurIsReadInTheOrderItHappened() {
    let log = log(watching: 1)
    log.record(field: 1, windowId: "a", keyLoss: false, isLive: alive)
    log.record(field: 1, windowId: "a", keyLoss: true, isLive: alive)
    XCTAssertFalse(log.take(field: 1), "the in-window blur queued first is read first")
    XCTAssertTrue(log.take(field: 1), "then the key loss after the field regained focus")
    XCTAssertFalse(log.take(field: 1), "nothing left reads as in-window")
  }

  func testOnlyWatchedFieldsAreQueued() {
    let log = log(watching: 1)
    log.record(field: 2, windowId: "a", keyLoss: true, isLive: alive)
    XCTAssertEqual(log.pending, 0, "a field no command bar watches is never stored")
    XCTAssertFalse(log.take(field: 2))
  }

  func testUnwatchingDropsTheQueueAndStopsRecording() {
    let log = log(watching: 1)
    log.record(field: 1, windowId: "a", keyLoss: true, isLive: alive)
    log.unwatch(field: 1)
    XCTAssertEqual(log.pending, 0)
    log.record(field: 1, windowId: "a", keyLoss: true, isLive: alive)
    XCTAssertEqual(log.pending, 0)
  }

  func testOverflowNeverShiftsTheQueueAndFailsClosed() {
    let log = log(watching: 1, cap: 4)
    for keyLoss in [false, true, true, true, true] { log.record(field: 1, windowId: "a", keyLoss: keyLoss, isLive: alive) }
    XCTAssertEqual(log.pending, 5, "every blur keeps its place")
    XCTAssertLessThanOrEqual(log.stored, 4, "memory stays at the cap")
    XCTAssertFalse(log.take(field: 1), "the first, in-window blur can never read key loss")
    for _ in 0..<4 { XCTAssertFalse(log.take(field: 1), "past the cap every blur reads in-window, so the bar closes rather than holding") }
    XCTAssertEqual(log.fields, 0)
    log.record(field: 1, windowId: "a", keyLoss: true, isLive: alive)
    XCTAssertTrue(log.take(field: 1), "a drained queue starts reading real causes again")
  }

  func testAReadConsumesItsRecordAndDropsTheEmptyField() {
    let log = log(watching: 1, 2)
    log.record(field: 1, windowId: "a", keyLoss: true, isLive: alive)
    log.record(field: 2, windowId: "a", keyLoss: false, isLive: alive)
    XCTAssertTrue(log.take(field: 1))
    XCTAssertFalse(log.take(field: 2))
    XCTAssertEqual(log.pending, 0)
    XCTAssertEqual(log.fields, 0)
  }

  func testFieldsAreKeptApart() {
    let log = log(watching: 1, 2)
    log.record(field: 1, windowId: "a", keyLoss: false, isLive: alive)
    log.record(field: 2, windowId: "a", keyLoss: true, isLive: alive)
    XCTAssertFalse(log.take(field: 1), "another field's later key loss is not this field's")
    XCTAssertTrue(log.take(field: 2))
  }

  func testAFieldThatIsGoneIsPrunedOnTheNextBlur() {
    let log = log(watching: 1, 2)
    var live = true
    log.record(field: 1, windowId: "a", keyLoss: true, isLive: { live })
    live = false
    log.record(field: 2, windowId: "a", keyLoss: false, isLive: alive)
    XCTAssertEqual(log.fields, 1)
    XCTAssertFalse(log.take(field: 1))
  }

  func testAnotherWindowTakingKeySettlesQueuedKeyLossAsInWindow() {
    let log = log(watching: 1, 2)
    log.record(field: 1, windowId: "a", keyLoss: true, isLive: alive)
    log.record(field: 2, windowId: "b", keyLoss: true, isLive: alive)
    log.settle { $0 != "b" }
    XCTAssertFalse(log.take(field: 1))
    XCTAssertTrue(log.take(field: 2))
  }

  func testClosingAWindowForgetsItsBlursEvenPastTheCap() {
    let log = log(watching: 1, 2, cap: 1)
    log.record(field: 1, windowId: "a", keyLoss: true, isLive: alive)
    log.record(field: 1, windowId: "a", keyLoss: true, isLive: alive)
    log.record(field: 2, windowId: "b", keyLoss: true, isLive: alive)
    log.forget { $0 == "a" }
    XCTAssertEqual(log.fields, 1)
    XCTAssertTrue(log.take(field: 2))
  }
}
