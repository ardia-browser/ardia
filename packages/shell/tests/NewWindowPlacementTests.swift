import CoreGraphics
import XCTest
@testable import ArdiaUpdaterCore

final class NewWindowPlacementTests: XCTestCase {
  private let minSize = CGSize(width: 420, height: 300)
  private let ultrawide = CGRect(x: 0, y: 0, width: 3440, height: 1415)

  func testCascadeReturnsNil() {
    let source = CGRect(x: 0, y: 0, width: 1400, height: 1415)
    XCTAssertNil(NewWindowPlacement.resolve(mode: .cascade, source: source, visible: ultrawide, minSize: minSize, sourceMinSize: minSize, sourceFixed: false))
  }

  func testBesidePlacesOnRightWhenMoreRoomOnRightWithoutResizingSource() {
    let source = CGRect(x: 0, y: 0, width: 1400, height: 1415)
    let result = NewWindowPlacement.resolve(mode: .beside, source: source, visible: ultrawide, minSize: minSize, sourceMinSize: minSize, sourceFixed: false)
    XCTAssertEqual(result, NewWindowPlacement.Result(windowFrame: CGRect(x: 1400, y: 0, width: 1400, height: 1415), sourceFrame: nil))
  }

  func testBesidePlacesOnLeftWhenMoreRoomOnLeft() {
    let source = CGRect(x: 2040, y: 100, width: 1400, height: 1200)
    let result = NewWindowPlacement.resolve(mode: .beside, source: source, visible: ultrawide, minSize: minSize, sourceMinSize: minSize, sourceFixed: false)
    XCTAssertEqual(result, NewWindowPlacement.Result(windowFrame: CGRect(x: 640, y: 100, width: 1400, height: 1200), sourceFrame: nil))
  }

  func testBesideFitsRemainingSpaceWhenSourceIsWiderThanFreeRoom() {
    let source = CGRect(x: 0, y: 0, width: 2200, height: 1415)
    let result = NewWindowPlacement.resolve(mode: .beside, source: source, visible: ultrawide, minSize: minSize, sourceMinSize: minSize, sourceFixed: false)
    XCTAssertEqual(result, NewWindowPlacement.Result(windowFrame: CGRect(x: 2200, y: 0, width: 1240, height: 1415), sourceFrame: nil))
  }

  func testBesideFallsBackWhenNeitherSideFitsMinimumWidth() {
    let laptop = CGRect(x: 0, y: 0, width: 1512, height: 945)
    let source = CGRect(x: 0, y: 0, width: 1512, height: 945)
    XCTAssertNil(NewWindowPlacement.resolve(mode: .beside, source: source, visible: laptop, minSize: minSize, sourceMinSize: minSize, sourceFixed: false))
  }

  func testEqualSplitsScreenEvenlyWithSourceOnLeft() {
    let source = CGRect(x: 100, y: 100, width: 1200, height: 900)
    let result = NewWindowPlacement.resolve(mode: .equal, source: source, visible: ultrawide, minSize: minSize, sourceMinSize: minSize, sourceFixed: false)
    XCTAssertEqual(
      result,
      NewWindowPlacement.Result(
        windowFrame: CGRect(x: 1720, y: 0, width: 1720, height: 1415),
        sourceFrame: CGRect(x: 0, y: 0, width: 1720, height: 1415)
      )
    )
  }

  func testEqualSplitsScreenEvenlyWithSourceOnRight() {
    let source = CGRect(x: 2100, y: 100, width: 1200, height: 900)
    let result = NewWindowPlacement.resolve(mode: .equal, source: source, visible: ultrawide, minSize: minSize, sourceMinSize: minSize, sourceFixed: false)
    XCTAssertEqual(
      result,
      NewWindowPlacement.Result(
        windowFrame: CGRect(x: 0, y: 0, width: 1720, height: 1415),
        sourceFrame: CGRect(x: 1720, y: 0, width: 1720, height: 1415)
      )
    )
  }

  func testEqualHandlesOddVisibleWidthWithoutGapOrOverlap() {
    let odd = CGRect(x: 0, y: 25, width: 2561, height: 1400)
    let source = CGRect(x: 0, y: 25, width: 1000, height: 1400)
    let result = NewWindowPlacement.resolve(mode: .equal, source: source, visible: odd, minSize: minSize, sourceMinSize: minSize, sourceFixed: false)
    XCTAssertEqual(
      result,
      NewWindowPlacement.Result(
        windowFrame: CGRect(x: 1280, y: 25, width: 1281, height: 1400),
        sourceFrame: CGRect(x: 0, y: 25, width: 1280, height: 1400)
      )
    )
  }

  func testEqualFallsBackWhenScreenTooNarrowForTwoWindows() {
    let narrow = CGRect(x: 0, y: 0, width: 800, height: 600)
    let source = CGRect(x: 0, y: 0, width: 600, height: 600)
    XCTAssertNil(NewWindowPlacement.resolve(mode: .equal, source: source, visible: narrow, minSize: minSize, sourceMinSize: minSize, sourceFixed: false))
  }

  func testFixedSourceFallsBackInBothModes() {
    let source = CGRect(x: 0, y: 0, width: 1400, height: 1415)
    XCTAssertNil(NewWindowPlacement.resolve(mode: .beside, source: source, visible: ultrawide, minSize: minSize, sourceMinSize: minSize, sourceFixed: true))
    XCTAssertNil(NewWindowPlacement.resolve(mode: .equal, source: source, visible: ultrawide, minSize: minSize, sourceMinSize: minSize, sourceFixed: true))
  }

  func testSecondaryDisplayWithNegativeOrigin() {
    let secondary = CGRect(x: -2560, y: 100, width: 2560, height: 1400)
    let source = CGRect(x: -2560, y: 100, width: 1000, height: 1400)
    let beside = NewWindowPlacement.resolve(mode: .beside, source: source, visible: secondary, minSize: minSize, sourceMinSize: minSize, sourceFixed: false)
    XCTAssertEqual(beside, NewWindowPlacement.Result(windowFrame: CGRect(x: -1560, y: 100, width: 1000, height: 1400), sourceFrame: nil))
    let equal = NewWindowPlacement.resolve(mode: .equal, source: source, visible: secondary, minSize: minSize, sourceMinSize: minSize, sourceFixed: false)
    XCTAssertEqual(
      equal,
      NewWindowPlacement.Result(
        windowFrame: CGRect(x: -1280, y: 100, width: 1280, height: 1400),
        sourceFrame: CGRect(x: -2560, y: 100, width: 1280, height: 1400)
      )
    )
  }
}
