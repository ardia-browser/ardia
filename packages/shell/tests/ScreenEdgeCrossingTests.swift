import XCTest
@testable import ArdiaUpdaterCore

final class ScreenEdgeCrossingTests: XCTestCase {
  func moves(_ path: [(past: CGFloat, at: TimeInterval)]) -> [ScreenEdgeCrossing.Move] {
    var crossing = ScreenEdgeCrossing()
    return path.compactMap { crossing.track(past: $0.past, at: $0.at) }
  }

  func testASweepToTheNextDisplayIsOneCrossing() {
    XCTAssertEqual(moves([(-60, 10), (-20, 10.01), (20, 10.02), (200, 10.03), (600, 10.04)]), [.crossed])
  }

  func testAnOvershootThatComesBackReturns() {
    XCTAssertEqual(moves([(-30, 10), (12, 10.01), (40, 10.05), (-10, 10.4)]), [.crossed, .returned])
  }

  func testComingBackTooLateIsNoReturn() {
    XCTAssertEqual(moves([(-30, 10), (12, 10.01), (-10, 10.8)]), [.crossed])
    var crossing = ScreenEdgeCrossing()
    _ = crossing.track(past: -30, at: 10)
    _ = crossing.track(past: 12, at: 10.01)
    XCTAssertTrue(crossing.awaitingReturn(at: 10.5))
    XCTAssertFalse(crossing.awaitingReturn(at: 10.8))
  }

  func testGoingPastTheReachIsNoReturn() {
    XCTAssertEqual(moves([(-30, 10), (12, 10.01), (120, 10.05), (40, 10.1), (-10, 10.2)]), [.crossed])
    XCTAssertEqual(moves([(-30, 10), (150, 10.01), (-10, 10.1)]), [.crossed])
  }

  func testLandingDeepInsideIsNoReturn() {
    XCTAssertEqual(moves([(-30, 10), (12, 10.01), (-200, 10.1)]), [.crossed])
  }

  func testAPointerThatStartsOutsideNeverCrosses() {
    XCTAssertEqual(moves([(30, 10), (10, 10.05), (-10, 10.1)]), [])
  }
}
