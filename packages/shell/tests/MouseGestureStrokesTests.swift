import XCTest
@testable import ArdiaUpdaterCore

final class MouseGestureStrokesTests: XCTestCase {
  private func strokes(_ moves: [(CGFloat, CGFloat)], from start: CGPoint = CGPoint(x: 500, y: 500)) -> MouseGestureStrokes {
    var strokes = MouseGestureStrokes(start: start)
    var point = start
    for (dx, dy) in moves {
      for _ in 0..<10 {
        point = CGPoint(x: point.x + dx / 10, y: point.y + dy / 10)
        strokes.add(point)
      }
    }
    return strokes
  }

  func testAJitterShorterThanAStepIsNoGestureSoTheRightClickStaysAClick() {
    let jitter = strokes([(6, -4), (-3, 9)])
    XCTAssertFalse(jitter.isGesture)
    XCTAssertNil(jitter.action)
  }

  func testOneStraightStrokeLeftGoesBackAndRightGoesForward() {
    XCTAssertEqual(strokes([(-120, 8)]).action?.command, "back")
    XCTAssertEqual(strokes([(140, -10)]).action?.command, "forward")
  }

  func testUpIsTowardTheTopOfTheScreenInAppKitCoordinates() {
    XCTAssertEqual(strokes([(0, 100), (0, -100)]).action?.command, "reload")
    XCTAssertEqual(strokes([(0, 100), (-100, 0)]).action?.command, "previousTab")
    XCTAssertEqual(strokes([(0, 100), (100, 0)]).action?.command, "nextTab")
  }

  func testTwoStrokeGesturesMatchEdgesDefaults() {
    XCTAssertEqual(strokes([(0, -100), (100, 0)]).action?.command, "closeTab")
    XCTAssertEqual(strokes([(-100, 0), (0, 100)]).action?.command, "reopenClosedTab")
    XCTAssertEqual(strokes([(100, 0), (0, 100)]).action?.command, "newTab")
  }

  func testAWobblyLineStaysOneStroke() {
    let wobbly = strokes([(-60, 15), (-60, -15), (-60, 10)])
    XCTAssertEqual(wobbly.directions, [.left])
    XCTAssertEqual(wobbly.action?.title, "Back")
  }

  func testAShapeWithNoActionOrTooManyStrokesRunsNothingButIsStillAGesture() {
    let unknown = strokes([(0, -100), (0, 100)])
    XCTAssertTrue(unknown.isGesture)
    XCTAssertNil(unknown.action)
    let tooLong = strokes([(0, -100), (100, 0), (0, 100)])
    XCTAssertTrue(tooLong.isGesture)
    XCTAssertNil(tooLong.action)
  }

  func testTheTrailKeepsEveryDistinctPointFromThePress() {
    var trail = MouseGestureStrokes(start: CGPoint(x: 0, y: 0))
    XCTAssertTrue(trail.add(CGPoint(x: 5, y: 0)))
    XCTAssertFalse(trail.add(CGPoint(x: 5, y: 0)))
    XCTAssertEqual(trail.points, [CGPoint(x: 0, y: 0), CGPoint(x: 5, y: 0)])
  }

  func testEveryActionHasItsOwnTelemetryName() {
    let names = MouseGestureStrokes.actions.values.map(\.telemetry)
    XCTAssertEqual(Set(names).count, names.count)
  }
}
