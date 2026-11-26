import XCTest
@testable import ArdiaUpdaterCore

final class UpdateCycleStampTests: XCTestCase {
  func testADeltaFallingBackToTheFullUpdateKeepsTheStampTheCycleBeganWith() {
    var period = "before"
    var cycle = UpdateCycleStamp<String>()
    XCTAssertEqual(cycle.stamp { period }, "before")
    period = "after"
    XCTAssertEqual(cycle.stamp { period }, "before")
    XCTAssertEqual(cycle.stamp { period }, "before")
  }

  func testTheNextUpdateCycleTakesAFreshStamp() {
    var period = "first"
    var cycle = UpdateCycleStamp<String>()
    XCTAssertEqual(cycle.stamp { period }, "first")
    cycle.end()
    period = "second"
    XCTAssertEqual(cycle.stamp { period }, "second")
  }

  func testEndingWithoutAStampLeavesNothingBehind() {
    var cycle = UpdateCycleStamp<String>()
    cycle.end()
    XCTAssertNil(cycle.current)
  }
}
