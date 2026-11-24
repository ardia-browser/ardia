import XCTest
@testable import ArdiaUpdaterCore

final class SummonedLandingTests: XCTestCase {
  private let own: Int32 = 100
  private let other: Int32 = 200

  func testAnotherAppInFrontNeedsTheWindowRaisedAgain() {
    XCTAssertTrue(SummonedLanding.needsRaise(own: own, frontmost: other))
  }

  func testArdiaInFrontOrNoFrontAppNeedsNoRaise() {
    XCTAssertFalse(SummonedLanding.needsRaise(own: own, frontmost: own))
    XCTAssertFalse(SummonedLanding.needsRaise(own: own, frontmost: nil))
  }

  func testTheWindowAboveTheFrontAppsWindowsLandedInFront() {
    let list = [
      SummonedLanding.Listed(number: 1, owner: 300, layer: 25),
      SummonedLanding.Listed(number: 7, owner: own, layer: 0),
      SummonedLanding.Listed(number: 2, owner: other, layer: 0),
    ]
    XCTAssertTrue(SummonedLanding.inFront(7, own: own, frontmost: other, frontToBack: list))
  }

  func testTheWindowBelowTheFrontAppsWindowLandedBehind() {
    let list = [
      SummonedLanding.Listed(number: 2, owner: other, layer: 0),
      SummonedLanding.Listed(number: 7, owner: own, layer: 0),
    ]
    XCTAssertFalse(SummonedLanding.inFront(7, own: own, frontmost: other, frontToBack: list))
  }

  func testWindowsOfABackgroundAppOrAnotherLayerDoNotCount() {
    let list = [
      SummonedLanding.Listed(number: 3, owner: 300, layer: 0),
      SummonedLanding.Listed(number: 4, owner: other, layer: 3),
      SummonedLanding.Listed(number: 7, owner: own, layer: 0),
      SummonedLanding.Listed(number: 2, owner: other, layer: 0),
    ]
    XCTAssertTrue(SummonedLanding.inFront(7, own: own, frontmost: other, frontToBack: list))
  }

  func testAWindowMissingFromTheListDidNotLand() {
    let list = [SummonedLanding.Listed(number: 2, owner: other, layer: 0)]
    XCTAssertFalse(SummonedLanding.inFront(7, own: own, frontmost: other, frontToBack: list))
  }
}
