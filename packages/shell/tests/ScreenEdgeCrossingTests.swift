import XCTest
@testable import ArdiaUpdaterCore

final class ScreenEdgeCrossingTests: XCTestCase {
  func sweep(_ xs: [CGFloat], every step: TimeInterval, from start: TimeInterval = 10) -> ScreenEdgeCrossing {
    var crossing = ScreenEdgeCrossing()
    for (i, x) in xs.enumerated() { crossing.track(CGPoint(x: x, y: 400), at: start + Double(i) * step) }
    return crossing
  }

  func testASweepToTheNextDisplayIsAFling() {
    let crossing = sweep([1600, 1580, 1560, 1540, 1520, 1500], every: 0.009)
    XCTAssertEqual(crossing.speed(right: false), 100 / 0.045, accuracy: 1)
    XCTAssertTrue(crossing.isFling(right: false))
    XCTAssertFalse(crossing.isFling(right: true))
  }

  func testASlowArrivalIsNoFling() {
    XCTAssertFalse(sweep([1530, 1524, 1518, 1512, 1506], every: 0.009).isFling(right: false))
  }

  func testAnArrivalAfterAPauseIsNoFling() {
    var crossing = sweep([1700, 1600], every: 0.008)
    crossing.track(CGPoint(x: 1500, y: 400), at: 10.2)
    XCTAssertEqual(crossing.speed(right: false), 0)
    XCTAssertFalse(crossing.isFling(right: false))
  }

  func testOnlyTheLastFiftyMillisecondsCount() {
    var crossing = sweep([3000, 2000, 1000], every: 0.03)
    XCTAssertEqual(crossing.speed(right: false), 1000 / 0.03, accuracy: 1)
    crossing.track(CGPoint(x: 1000, y: 400), at: 10.12)
    XCTAssertEqual(crossing.speed(right: false), 0)
  }

  func testTheRightEdgeCountsMovesToTheRight() {
    XCTAssertTrue(sweep([3000, 3020, 3040, 3060], every: 0.008).isFling(right: true))
  }

  func testPushesAddUpToThePushDistance() {
    var crossing = ScreenEdgeCrossing()
    crossing.startPush()
    XCTAssertFalse(crossing.push(by: 20))
    XCTAssertFalse(crossing.push(by: -30))
    XCTAssertFalse(crossing.push(by: 20))
    XCTAssertFalse(crossing.push(by: 20))
    XCTAssertTrue(crossing.push(by: 4))
    crossing.startPush()
    XCTAssertEqual(crossing.pushed, 0)
  }

  func testForgettingDropsSpeedAndPush() {
    var crossing = sweep([1600, 1560, 1520], every: 0.008)
    _ = crossing.push(by: 40)
    crossing.forget()
    XCTAssertEqual(crossing.speed(right: false), 0)
    XCTAssertEqual(crossing.pushed, 0)
  }
}
