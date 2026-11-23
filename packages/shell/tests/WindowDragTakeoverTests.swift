import XCTest
@testable import ArdiaUpdaterCore

final class WindowDragTakeoverTests: XCTestCase {
  func testARefusedDragStillHeldIsTakenOver() {
    XCTAssertEqual(WindowDragTakeover.outcome(pressedAt: 100, latestPressAt: 100, queuedPressAt: nil, held: true), .takeOver)
  }

  func testADragEndedAtTheReleaseStaysWithMacOS() {
    XCTAssertEqual(WindowDragTakeover.outcome(pressedAt: 100, latestPressAt: 100, queuedPressAt: nil, held: false), .native)
  }

  func testASecondPress22MillisecondsLaterMakesTheFirstCompletionStale() {
    XCTAssertEqual(WindowDragTakeover.outcome(pressedAt: 100, latestPressAt: 100.022, queuedPressAt: nil, held: true), .stale)
  }

  func testASecondPressStillQueuedMakesTheFirstCompletionStale() {
    XCTAssertEqual(WindowDragTakeover.outcome(pressedAt: 100, latestPressAt: 100, queuedPressAt: 100.022, held: true), .stale)
  }

  func testAStaleCompletionAfterTheReleaseCountsAsNeither() {
    XCTAssertEqual(WindowDragTakeover.outcome(pressedAt: 100, latestPressAt: 100.3, queuedPressAt: nil, held: true), .stale)
    XCTAssertEqual(WindowDragTakeover.outcome(pressedAt: 100, latestPressAt: 100.3, queuedPressAt: nil, held: false), .stale)
  }

  func testAPressThatIsStillTheLatestAndHeldIsTakenOverHoweverLateTheCompletion() {
    XCTAssertEqual(WindowDragTakeover.outcome(pressedAt: 100, latestPressAt: 99, queuedPressAt: nil, held: true), .takeOver)
    XCTAssertEqual(WindowDragTakeover.outcome(pressedAt: 100, latestPressAt: nil, queuedPressAt: nil, held: true), .takeOver)
  }

  func testAnEventOlderThanThePressIsNotPartOfItsGesture() {
    XCTAssertFalse(WindowDragTakeover.belongs(eventAt: 99.99, pressedAt: 100))
    XCTAssertTrue(WindowDragTakeover.belongs(eventAt: 100, pressedAt: 100))
    XCTAssertTrue(WindowDragTakeover.belongs(eventAt: 100.4, pressedAt: 100))
  }

  func testATakeoverAfterAPartialNativeMoveStaysAnchoredToThePressTimeOrigin() {
    let pressOrigin = CGPoint(x: 100, y: 100), press = CGPoint(x: 150, y: 120)
    let movedByMacOS = CGPoint(x: 130, y: 100), pointer = CGPoint(x: 190, y: 120)
    XCTAssertEqual(WindowDragTakeover.anchoredOrigin(origin: pressOrigin, press: press, pointer: pointer), CGPoint(x: 140, y: 100))
    XCTAssertNotEqual(
      WindowDragTakeover.anchoredOrigin(origin: movedByMacOS, press: press, pointer: pointer),
      WindowDragTakeover.anchoredOrigin(origin: pressOrigin, press: press, pointer: pointer),
      "anchoring on the origin macOS left behind would jump the window by its partial move")
  }
}
