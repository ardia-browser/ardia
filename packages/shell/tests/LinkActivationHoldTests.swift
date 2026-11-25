import CoreGraphics
import XCTest
@testable import ArdiaUpdaterCore

final class LinkActivationHoldTests: XCTestCase {
  private let own: Int32 = 100
  private let linkSource: Int32 = 200
  private let dock: Int32 = 300
  private let stageManager: Int32 = 400
  private var managers: Set<Int32> { [dock, stageManager] }

  private var nextNumber = 1

  private let windowServer: Int32 = 500
  private let zoom: Int32 = 600

  private func window(_ owner: Int32, layer: Int = 0, _ rect: CGRect) -> LinkActivationHold.Listed {
    nextNumber += 1
    return LinkActivationHold.Listed(number: nextNumber, owner: owner, layer: layer, bounds: rect, windowServer: owner == windowServer)
  }

  private func cursor(at point: CGPoint) -> LinkActivationHold.Listed {
    window(windowServer, layer: Int(CGWindowLevelForKey(.cursorWindow)), CGRect(x: point.x - 8, y: point.y - 8, width: 32, height: 32))
  }

  func testARecordedCursorAboveMissionControlStillLeavesItToTheDock() {
    let pointer = CGPoint(x: 500, y: 400)
    let list = [
      cursor(at: pointer),
      window(dock, layer: 20, CGRect(x: 0, y: 0, width: 1512, height: 982)),
      window(linkSource, CGRect(x: 100, y: 100, width: 900, height: 700)),
    ]
    XCTAssertTrue(LinkActivationHold.leftToWindowManager(pointer: pointer, own: own, windowManagers: managers, frontToBack: list))
  }

  func testARecordedCursorAboveTheLinkAppStillHolds() {
    let pointer = CGPoint(x: 500, y: 400)
    let list = [
      cursor(at: pointer),
      window(linkSource, CGRect(x: 100, y: 100, width: 900, height: 700)),
      window(own, CGRect(x: 300, y: 80, width: 1100, height: 800)),
    ]
    XCTAssertFalse(LinkActivationHold.leftToWindowManager(pointer: pointer, own: own, windowManagers: managers, frontToBack: list))
  }

  func testOverlaysAboveEverythingAreLookedThrough() {
    let pointer = CGPoint(x: 500, y: 400)
    let list = [
      window(zoom, layer: Int(CGWindowLevelForKey(.assistiveTechHighWindow)), CGRect(x: 300, y: 200, width: 400, height: 400)),
      window(linkSource, layer: Int(CGWindowLevelForKey(.draggingWindow)), CGRect(x: 480, y: 380, width: 64, height: 64)),
      window(windowServer, layer: 25, CGRect(x: 0, y: 380, width: 1512, height: 40)),
      window(dock, layer: 20, CGRect(x: 0, y: 0, width: 1512, height: 982)),
    ]
    XCTAssertEqual(LinkActivationHold.underPointer(pointer, frontToBack: list)?.owner, dock)
  }

  func testAClickInMissionControlIsLeftToTheDock() {
    let list = [
      window(dock, layer: 20, CGRect(x: 0, y: 0, width: 1512, height: 982)),
      window(linkSource, CGRect(x: 100, y: 100, width: 900, height: 700)),
      window(own, CGRect(x: 300, y: 80, width: 1100, height: 800)),
    ]
    XCTAssertTrue(LinkActivationHold.leftToWindowManager(pointer: CGPoint(x: 500, y: 400), own: own, windowManagers: managers, frontToBack: list))
  }

  func testAWindowMissionControlAlreadyPutInFrontUnderThePointerIsLeftAlone() {
    let list = [
      window(own, CGRect(x: 300, y: 80, width: 1100, height: 800)),
      window(linkSource, CGRect(x: 100, y: 100, width: 900, height: 700)),
    ]
    XCTAssertTrue(LinkActivationHold.leftToWindowManager(pointer: CGPoint(x: 500, y: 400), own: own, windowManagers: managers, frontToBack: list))
  }

  func testAStageManagerStripClickIsLeftToStageManager() {
    let list = [
      window(stageManager, CGRect(x: 0, y: 200, width: 180, height: 500)),
      window(linkSource, CGRect(x: 200, y: 100, width: 900, height: 700)),
    ]
    XCTAssertTrue(LinkActivationHold.leftToWindowManager(pointer: CGPoint(x: 90, y: 400), own: own, windowManagers: managers, frontToBack: list))
  }

  func testAPointerRestingOnArdiaBehindTheAppInFrontKeepsTheHold() {
    let list = [
      window(linkSource, CGRect(x: 0, y: 0, width: 600, height: 900)),
      window(own, CGRect(x: 300, y: 80, width: 1100, height: 800)),
    ]
    XCTAssertFalse(LinkActivationHold.leftToWindowManager(pointer: CGPoint(x: 900, y: 400), own: own, windowManagers: managers, frontToBack: list))
  }

  func testAnotherArdiaWindowBehindTheAppInFrontKeepsTheHoldEvenWhenOneArdiaWindowIsFrontmost() {
    let list = [
      window(own, CGRect(x: 1200, y: 0, width: 300, height: 300)),
      window(linkSource, CGRect(x: 0, y: 0, width: 600, height: 900)),
      window(own, CGRect(x: 300, y: 80, width: 1100, height: 800)),
    ]
    XCTAssertFalse(LinkActivationHold.leftToWindowManager(pointer: CGPoint(x: 900, y: 400), own: own, windowManagers: managers, frontToBack: list))
  }

  func testALinkClickedInAnotherAppKeepsTheHold() {
    let list = [
      window(linkSource, CGRect(x: 100, y: 100, width: 900, height: 700)),
      window(own, CGRect(x: 300, y: 80, width: 1100, height: 800)),
    ]
    XCTAssertFalse(LinkActivationHold.leftToWindowManager(pointer: CGPoint(x: 500, y: 400), own: own, windowManagers: managers, frontToBack: list))
  }

  func testTheDockBarBehindTheLinkAppDoesNotCount() {
    let list = [
      window(linkSource, CGRect(x: 0, y: 0, width: 1512, height: 982)),
      window(dock, layer: 20, CGRect(x: 400, y: 900, width: 700, height: 80)),
    ]
    XCTAssertFalse(LinkActivationHold.leftToWindowManager(pointer: CGPoint(x: 500, y: 940), own: own, windowManagers: managers, frontToBack: list))
  }

  func testAPointerOverNoWindowKeepsTheHold() {
    let list = [window(linkSource, CGRect(x: 100, y: 100, width: 300, height: 300))]
    XCTAssertFalse(LinkActivationHold.leftToWindowManager(pointer: CGPoint(x: 900, y: 900), own: own, windowManagers: managers, frontToBack: list))
  }

  func testAnUnreadablePointerOrWindowListHoldsNothing() {
    let list = [window(linkSource, CGRect(x: 100, y: 100, width: 900, height: 700))]
    XCTAssertTrue(LinkActivationHold.leftToWindowManager(pointer: nil, own: own, windowManagers: managers, frontToBack: list))
    XCTAssertTrue(LinkActivationHold.leftToWindowManager(pointer: CGPoint(x: 500, y: 400), own: own, windowManagers: managers, frontToBack: []))
  }

  func testWindowsBelowTheNormalLayerAreSkipped() {
    let list = [
      window(dock, layer: -2147483623, CGRect(x: 0, y: 0, width: 1512, height: 982)),
      window(linkSource, CGRect(x: 100, y: 100, width: 900, height: 700)),
    ]
    XCTAssertEqual(LinkActivationHold.underPointer(CGPoint(x: 500, y: 400), frontToBack: list)?.owner, linkSource)
  }
}
