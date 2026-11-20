import XCTest
@testable import ArdiaUpdaterCore

final class SidebarEdgeRegionsTests: XCTestCase {
  private let screen = CGRect(x: 0, y: 0, width: 1800, height: 1100)
  private let frame = CGRect(x: 300, y: 100, width: 1200, height: 800)

  private func geometry(
    right: Bool = false,
    hold: CGFloat = 0,
    edgeBand: CGFloat = 0,
    appActive: Bool = true,
    peeking: Bool = false,
    immediate: Bool = false
  ) -> SidebarEdgeTracker.Geometry {
    SidebarEdgeTracker.Geometry(
      frame: frame,
      screen: screen,
      right: right,
      hold: hold,
      edgeBand: edgeBand,
      innerReveal: SidebarEdgeRegions.innerRevealWidth,
      innerExpanded: SidebarEdgeRegions.innerExpandedWidth,
      outerApproach: SidebarEdgeRegions.outerApproachReach,
      outerPersist: SidebarEdgeRegions.outerPersistReach,
      inactiveReach: SidebarEdgeRegions.inactiveEdgeReach,
      verticalSlack: SidebarEdgeRegions.verticalHoldSlack,
      appActive: appActive,
      peeking: peeking,
      immediate: immediate
    )
  }

  private func step(
    _ tracker: inout SidebarEdgeTracker,
    x: CGFloat,
    y: CGFloat = 400,
    at time: TimeInterval,
    right: Bool = false,
    hold: CGFloat = 0,
    edgeBand: CGFloat = 0,
    appActive: Bool = true,
    peeking: Bool = false,
    immediate: Bool = false,
    initial: Bool = false
  ) -> SidebarEdgeTracker.Decision {
    let point = CGPoint(x: x, y: y)
    let g = geometry(right: right, hold: hold, edgeBand: edgeBand, appActive: appActive, peeking: peeking, immediate: immediate)
    let r = tracker.regions(for: point, geometry: g)
    return tracker.step(
      point: point,
      at: time,
      inInnerBand: r.inInnerBand,
      inInnerEdge: r.inInnerEdge,
      inOuterBand: r.inOuterBand,
      inWindow: r.inWindow,
      peeking: peeking,
      immediate: immediate,
      initial: initial
    )
  }

  func testOuterApproachStartsAt50AndExpandsTo250OnceEntered() {
    var tracker = SidebarEdgeTracker()
    let farOutside = step(&tracker, x: 240, at: 10.0)
    XCTAssertFalse(farOutside.over)
    XCTAssertNil(farOutside.nextDeadline)

    let entered = step(&tracker, x: 260, at: 10.01)
    XCTAssertFalse(entered.over)
    XCTAssertNotNil(entered.nextDeadline)

    let expanded = step(&tracker, x: 100, at: 10.05)
    XCTAssertFalse(expanded.over)
    XCTAssertNotNil(expanded.nextDeadline)

    let revealed = step(&tracker, x: 100, at: 10.13)
    XCTAssertTrue(revealed.over)
    XCTAssertNil(revealed.nextDeadline)
  }

  func testLeavingFromInsideWindowGrants250PtOuterReachAndHoldsContinuously() {
    var tracker = SidebarEdgeTracker()
    XCTAssertFalse(step(&tracker, x: 500, at: 1.0).over)

    let crossFar = step(&tracker, x: 120, at: 1.05)
    XCTAssertFalse(crossFar.over)
    XCTAssertEqual(crossFar.nextDeadline ?? -1, 1.13, accuracy: 0.001)

    XCTAssertTrue(step(&tracker, x: 120, at: 1.13).over)
    XCTAssertTrue(step(&tracker, x: 60, at: 1.20, hold: 209, peeking: true, immediate: true).over)
    XCTAssertTrue(step(&tracker, x: 295, at: 1.25, hold: 209, peeking: true, immediate: true).over)
    XCTAssertTrue(step(&tracker, x: 302, at: 1.30, hold: 209, peeking: true, immediate: true).over)
    XCTAssertTrue(step(&tracker, x: 380, at: 1.35, hold: 209, peeking: true, immediate: true).over)
    XCTAssertFalse(step(&tracker, x: 40, at: 1.40, hold: 209, peeking: true, immediate: true).over)
  }

  func testBriskPassThroughNeverFlickersOpen() {
    var tracker = SidebarEdgeTracker()
    XCTAssertFalse(step(&tracker, x: 500, at: 2.0).over)
    XCTAssertFalse(step(&tracker, x: 302, at: 2.01).over)
    XCTAssertFalse(step(&tracker, x: 280, at: 2.02).over)
    XCTAssertFalse(step(&tracker, x: 100, at: 2.03).over)
    let exited = step(&tracker, x: 40, at: 2.04)
    XCTAssertFalse(exited.over)
    XCTAssertNil(exited.nextDeadline)
  }

  func testContinuousMotionInOuterRegionRevealsAfterLingerWithoutStopping() {
    var tracker = SidebarEdgeTracker()
    XCTAssertFalse(step(&tracker, x: 290, at: 5.0).over)
    XCTAssertFalse(step(&tracker, x: 260, at: 5.04).over)
    XCTAssertFalse(step(&tracker, x: 220, at: 5.08).over)
    XCTAssertFalse(step(&tracker, x: 180, at: 5.12).over)
    XCTAssertTrue(step(&tracker, x: 140, at: 5.16).over)
  }

  func testContinuousMotionInInnerRegionRevealsAfter150MsWithoutStopping() {
    var tracker = SidebarEdgeTracker()
    XCTAssertFalse(step(&tracker, x: 302, y: 400, at: 6.0).over)
    XCTAssertFalse(step(&tracker, x: 302, y: 430, at: 6.05).over)
    XCTAssertFalse(step(&tracker, x: 302, y: 460, at: 6.10).over)
    XCTAssertTrue(step(&tracker, x: 302, y: 490, at: 6.15).over)
  }

  func testInnerEdgeWidthAndBridgeHysteresisFrom0To3And3To9() {
    var tracker = SidebarEdgeTracker()
    XCTAssertFalse(step(&tracker, x: 500, at: 3.0).over)
    XCTAssertNil(step(&tracker, x: 305, at: 3.02).nextDeadline)

    XCTAssertFalse(step(&tracker, x: 301, at: 3.04).over)
    XCTAssertTrue(step(&tracker, x: 301, at: 3.12).over)
    XCTAssertTrue(step(&tracker, x: 306, at: 3.13, hold: 0, peeking: false).over)
    XCTAssertFalse(step(&tracker, x: 310, at: 3.14, hold: 0, peeking: false).over)
  }

  func testRightSideSymmetry() {
    var tracker = SidebarEdgeTracker()
    XCTAssertFalse(step(&tracker, x: 1560, at: 4.0, right: true).over)
    XCTAssertFalse(step(&tracker, x: 1540, at: 4.01, right: true).over)
    XCTAssertTrue(step(&tracker, x: 1540, at: 4.09, right: true).over)
    XCTAssertTrue(step(&tracker, x: 1740, at: 4.12, right: true, hold: 209, peeking: true, immediate: true).over)
    XCTAssertFalse(step(&tracker, x: 1760, at: 4.15, right: true, hold: 209, peeking: true, immediate: true).over)
  }

  func testVerticalSlackAppliesOnlyWhileActiveOrPeeking() {
    var tracker = SidebarEdgeTracker()
    XCTAssertFalse(step(&tracker, x: 295, y: 95, at: 7.0).over)
    XCTAssertTrue(step(&tracker, x: 295, y: 120, at: 7.0, immediate: true).over)
    XCTAssertTrue(step(&tracker, x: 295, y: 95, at: 7.05, hold: 209, peeking: true, immediate: true).over)
    XCTAssertFalse(step(&tracker, x: 295, y: 60, at: 7.10, hold: 209, peeking: true, immediate: true).over)
  }

  func testInitialParkedEdgeReportsImmediatelyAndScreenClampIsRespected() {
    var tracker = SidebarEdgeTracker()
    XCTAssertTrue(step(&tracker, x: 295, at: 8.0, initial: true).over)

    let edgeWindow = CGRect(x: 100, y: 100, width: 1200, height: 800)
    let g = SidebarEdgeTracker.Geometry(
      frame: edgeWindow,
      screen: screen,
      right: false,
      hold: 209,
      edgeBand: 0,
      innerReveal: 3,
      innerExpanded: 9,
      outerApproach: 50,
      outerPersist: 250,
      inactiveReach: 24,
      verticalSlack: 24,
      appActive: true,
      peeking: true,
      immediate: true
    )
    XCTAssertTrue(tracker.regions(for: CGPoint(x: 0, y: 400), geometry: g).inOuterBand)
    XCTAssertFalse(tracker.regions(for: CGPoint(x: -1, y: 400), geometry: g).inOuterBand)
  }

  func testInnerEdgeExpandsImmediatelyOnEntryWithoutBlockingDirect5PtInside() {
    var tracker = SidebarEdgeTracker()
    XCTAssertFalse(step(&tracker, x: 500, at: 1.0).over)
    XCTAssertNil(step(&tracker, x: 305, at: 1.01).nextDeadline)

    let entered = step(&tracker, x: 302, at: 1.02)
    XCTAssertFalse(entered.over)
    XCTAssertNotNil(entered.nextDeadline)

    let rebound = step(&tracker, x: 306, at: 1.04)
    XCTAssertFalse(rebound.over)
    XCTAssertEqual(rebound.nextDeadline ?? -1, 1.12, accuracy: 0.001)

    let revealed = step(&tracker, x: 306, at: 1.12)
    XCTAssertTrue(revealed.over)
    XCTAssertTrue(revealed.atEdge)
  }

  func testEnteringInnerEdgeFromOutsideUsesExpanded9PtBand() {
    var tracker = SidebarEdgeTracker()
    let outside = step(&tracker, x: 295, at: 2.0)
    XCTAssertFalse(outside.over)
    XCTAssertNotNil(outside.nextDeadline)

    let crossed = step(&tracker, x: 306, at: 2.02)
    XCTAssertFalse(crossed.over)
    XCTAssertEqual(crossed.nextDeadline ?? -1, 2.10, accuracy: 0.001)

    let revealed = step(&tracker, x: 306, at: 2.10)
    XCTAssertTrue(revealed.over)
    XCTAssertTrue(revealed.atEdge)
  }

  func testSubPointTremorDoesNotResetStopTimer() {
    var tracker = SidebarEdgeTracker()
    XCTAssertFalse(step(&tracker, x: 500, at: 3.0).over)
    let first = step(&tracker, x: 301.0, y: 400.0, at: 3.02)
    XCTAssertFalse(first.over)
    XCTAssertEqual(first.nextDeadline ?? -1, 3.10, accuracy: 0.001)

    let jitter = step(&tracker, x: 301.4, y: 400.5, at: 3.07)
    XCTAssertFalse(jitter.over)
    XCTAssertEqual(jitter.nextDeadline ?? -1, 3.10, accuracy: 0.001)

    let revealed = step(&tracker, x: 301.2, y: 400.2, at: 3.10)
    XCTAssertTrue(revealed.over)
    XCTAssertTrue(revealed.atEdge)
  }

  func testAtEdgeDistinguishesEdgeBandFromWideHoldColumn() {
    var tracker = SidebarEdgeTracker()
    let edge = step(&tracker, x: 302, at: 4.0, hold: 244, peeking: true, immediate: true)
    XCTAssertTrue(edge.over)
    XCTAssertTrue(edge.atEdge)

    let column = step(&tracker, x: 380, at: 4.05, hold: 244, peeking: true, immediate: true)
    XCTAssertTrue(column.over)
    XCTAssertFalse(column.atEdge)

    let outer = step(&tracker, x: 260, at: 4.10, hold: 244, peeking: true, immediate: true)
    XCTAssertTrue(outer.over)
    XCTAssertTrue(outer.atEdge)
  }
}
