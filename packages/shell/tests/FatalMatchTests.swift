import XCTest
@testable import ArdiaUpdaterCore

final class FatalMatchTests: XCTestCase {
  private let written = Date(timeIntervalSince1970: 1_000_000)

  func testOfTwoAbortsSixtySecondsApartTheFileGoesToTheOneItPrecededWhicheverIsListedFirst() {
    let earlier = written.addingTimeInterval(-60)
    let matching = written.addingTimeInterval(0.4)
    XCTAssertEqual(FatalMatch.crash(forFileWrittenAt: written, among: [earlier, matching]), 1)
    XCTAssertEqual(FatalMatch.crash(forFileWrittenAt: written, among: [matching, earlier]), 0)
  }

  func testAnEarlierAbortAloneDoesNotTakeAFileWrittenAMinuteLater() {
    XCTAssertNil(FatalMatch.crash(forFileWrittenAt: written, among: [written.addingTimeInterval(-60)]))
  }

  func testAFileFromBeforeALaterAbortIsNotItsReason() {
    XCTAssertNil(FatalMatch.crash(forFileWrittenAt: written, among: [written.addingTimeInterval(45)]))
  }

  func testTheNearestOfTwoCloseAbortsWinsAndSecondPrecisionSkewIsAllowed() {
    let skewed = written.addingTimeInterval(-0.9)
    let later = written.addingTimeInterval(5)
    XCTAssertEqual(FatalMatch.crash(forFileWrittenAt: written, among: [later, skewed]), 1)
  }

  func testNoAbortsMeansNoMatch() {
    XCTAssertNil(FatalMatch.crash(forFileWrittenAt: written, among: []))
  }
}
