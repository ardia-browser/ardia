import XCTest
@testable import ArdiaWheelSteerCore

private let short = WheelRange(lo: 500, hi: 500)
private let tall = WheelRange(lo: 500, hi: 800)

private struct Step {
  var phase: WheelPhase
  var dy: Double
  var gap = 16.0
  var momentum = false
  var precise = true
}

private func swipe(_ phase: WheelPhase, _ dy: Double, gap: Double = 16, momentum: Bool = false) -> Step {
  Step(phase: phase, dy: dy, gap: gap, momentum: momentum)
}

private func notch(_ dy: Double = -1, gap: Double = 16) -> Step {
  Step(phase: .none, dy: dy, gap: gap, precise: false)
}

private final class Column {
  var steer = WheelSteer()
  var range: WheelRange
  var at: Double
  var now = 1000.0

  init(range: WheelRange = short, at: Double? = nil) {
    self.range = range
    self.at = at ?? range.lo
  }

  @discardableResult
  func run(_ steps: [Step]) -> [WheelAction] {
    steps.map { step in
      now += step.gap
      let action = steer.read(WheelInput(dy: step.dy, phase: step.phase, momentum: step.momentum, precise: step.precise), at: at, range: range, now: now)
      switch action {
      case .place(let y), .ease(let y): at = y
      default: break
      }
      return action
    }
  }

  func moveAndGlide(_ action: WheelAction, to next: WheelRange, glideMs: Double = 600) {
    guard case .move(let direction) = action else { return }
    range = next
    at = direction > 0 ? next.lo : next.hi
    steer.glideStarted(ms: glideMs, now: now)
  }
}

private func kinds(_ actions: [WheelAction]) -> [String] {
  actions.map {
    switch $0 {
    case .none: "none"
    case .place: "place"
    case .ease: "ease"
    case .move(let d): "move\(d)"
    case .settle: "settle"
    }
  }
}

final class WheelSteerTests: XCTestCase {
  func testASwipePastTheThresholdMovesOnceAndIgnoresTheRestOfTheGesture() {
    let out = Column().run([swipe(.began, -10), swipe(.changed, -10), swipe(.changed, -10), swipe(.changed, -10), swipe(.ended, 0), swipe(.none, -30, momentum: true)])
    XCTAssertEqual(kinds(out), ["place", "place", "move1", "none", "none", "none"])
  }

  func testAShortSwipeFollowsTheFingerAndSettlesBackWhenTheFingerLifts() {
    let out = Column().run([swipe(.began, -5), swipe(.changed, -5), swipe(.ended, 0)])
    XCTAssertEqual(kinds(out), ["place", "place", "settle"])
    XCTAssertEqual(out[1], .place(500 + 10 * 0.4))
  }

  func testALiftThatArrivesAfterAPauseStillBelongsToTheSameGesture() {
    let out = Column().run([swipe(.began, -10), swipe(.changed, -10), swipe(.changed, -10), swipe(.ended, 0, gap: 600)])
    XCTAssertEqual(kinds(out), ["place", "place", "move1", "none"])
  }

  func testEachNewSwipeMovesAgainHoweverSoonItFollows() {
    let out = Column().run([swipe(.began, -15), swipe(.changed, -15), swipe(.ended, 0), swipe(.began, -15, gap: 40), swipe(.changed, -15), swipe(.ended, 0)])
    XCTAssertEqual(kinds(out), ["place", "move1", "none", "place", "move1", "none"])
  }

  func testSwipingBackMovesBack() {
    XCTAssertEqual(kinds(Column().run([swipe(.began, 15), swipe(.changed, 15)])), ["place", "move-1"])
  }

  func testATallSectionScrollsInsideOneToOneBeforeItMovesOn() {
    let column = Column(range: tall)
    let out = column.run([swipe(.began, -7), swipe(.changed, -3.5), swipe(.changed, -100), swipe(.changed, -300), swipe(.changed, -100), swipe(.ended, 0)])
    XCTAssertEqual(out, [.place(507), .place(510.5), .place(610.5), .place(800), .none, .none])
  }

  func testMomentumKeepsScrollingInsideATallSectionAndStopsAtItsEdge() {
    let out = Column(range: tall).run([swipe(.began, -20), swipe(.changed, -40), swipe(.ended, 0), swipe(.none, -60, momentum: true), swipe(.none, -40, momentum: true), swipe(.none, -400, momentum: true), swipe(.none, -10, momentum: true)])
    XCTAssertEqual(out, [.place(520), .place(560), .none, .place(620), .place(660), .place(800), .none])
  }

  func testMomentumAfterAMoveNeverScrollsTheNextSection() {
    let column = Column()
    let out = column.run([swipe(.began, -15), swipe(.changed, -15)])
    column.moveAndGlide(out[1], to: tall)
    XCTAssertEqual(kinds(column.run([swipe(.ended, 0), swipe(.none, -30, momentum: true), swipe(.none, -20, momentum: true)])), ["none", "none", "none"])
    XCTAssertEqual(column.at, tall.lo)
  }

  func testZeroLengthDeltasOutsideALiftDoNothing() {
    XCTAssertEqual(kinds(Column().run([swipe(.mayBegin, 0), swipe(.changed, 0)])), ["none", "none"])
  }

  func testASwipeThatStartsAtTheBottomEdgeOfATallSectionPullsThenMovesOn() {
    let out = Column(range: tall, at: tall.hi).run([swipe(.began, -10), swipe(.changed, -10), swipe(.changed, -10), swipe(.changed, -10), swipe(.ended, 0)])
    XCTAssertEqual(kinds(out), ["place", "place", "move1", "none", "none"])
    XCTAssertEqual(out[0], .place(804))
    XCTAssertEqual(out[1], .place(808))
  }

  func testASwipeThatStartsAtTheTopEdgeOfATallSectionPullsThenMovesBack() {
    let out = Column(range: tall, at: tall.lo).run([swipe(.began, 10), swipe(.changed, 10), swipe(.changed, 10), swipe(.changed, 10), swipe(.ended, 0)])
    XCTAssertEqual(kinds(out), ["place", "place", "move-1", "none", "none"])
    XCTAssertEqual(out[0], .place(496))
  }

  func testAPullAtTheEdgeThatReversesScrollsBackInsideTheSection() {
    XCTAssertEqual(Column(range: tall, at: tall.hi).run([swipe(.began, -10), swipe(.changed, 30)]), [.place(804), .place(770)])
  }

  func testANewSwipeThatOpensWithAZeroLengthBeganMovesAgainRightAfterTheLastOne() {
    let out = Column().run([swipe(.began, -15), swipe(.changed, -15), swipe(.ended, 0), swipe(.began, 0, gap: 40), swipe(.changed, -15), swipe(.changed, -15), swipe(.ended, 0)])
    XCTAssertEqual(kinds(out), ["place", "move1", "none", "none", "place", "move1", "none"])
  }

  func testPhaselessPreciseScrollingSplitsIntoGesturesAtPauses() {
    let out = Column().run([swipe(.none, -15), swipe(.none, -15), swipe(.none, -15), swipe(.none, -15, gap: 300), swipe(.none, -15)])
    XCTAssertEqual(kinds(out), ["place", "move1", "none", "place", "move1"])
  }

  func testAFastSixNotchSpinAtAShortSectionMovesExactlyOnce() {
    let column = Column()
    var out = column.run([notch()])
    column.moveAndGlide(out[0], to: short)
    out += column.run([notch(gap: 25), notch(-2, gap: 25), notch(-3, gap: 20), notch(-3, gap: 20), notch(-2, gap: 30)])
    XCTAssertEqual(kinds(out), ["move1", "none", "none", "none", "none", "none"])
  }

  func testNotchesDuringTheMoveAreAbsorbedUntilTheGlideIsNearlyDone() {
    let column = Column()
    let first = column.run([notch()])
    column.moveAndGlide(first[0], to: short)
    let during = column.run([notch(gap: 200), notch(gap: 200)])
    let after = column.run([notch(gap: 30)])
    XCTAssertEqual(kinds(first + during + after), ["move1", "none", "none", "move1"])
  }

  func testAMoveTheFlowRefusesHoldsNotchesOnlyBriefly() {
    let column = Column()
    XCTAssertEqual(kinds(column.run([notch(), notch(gap: 150), notch(gap: 150), notch(gap: 100)])), ["move1", "none", "none", "move1"])
  }

  func testAGlideNotStartedByANotchHoldsNothing() {
    let column = Column()
    column.steer.glideStarted(ms: 600, now: column.now)
    XCTAssertEqual(kinds(column.run([notch(gap: 30)])), ["move1"])
  }

  func testNotchesInsideATallSectionEaseByTheirDeltaAndAccumulate() {
    let out = Column(range: tall).run([notch(), notch(gap: 30), notch(-2.5, gap: 30), notch(0.5, gap: 30)])
    XCTAssertEqual(out, [.ease(540), .ease(580), .ease(680), .ease(660)])
  }

  func testASpinThatReachesTheEdgeInsideStopsThereAndTheNextSpinMovesOn() {
    let column = Column(range: tall, at: 720)
    let out = column.run([notch(), notch(gap: 30), notch(gap: 30), notch(gap: 30), notch(gap: 300)])
    XCTAssertEqual(out, [.ease(760), .ease(800), .none, .none, .move(1)])
  }

  func testNotchesUpAtTheTopOfATallSectionMoveBack() {
    XCTAssertEqual(Column(range: tall).run([notch(1)]), [.move(-1)])
  }

  func testAfterAMoveIntoATallSectionALongSpinScrollsInsideIt() {
    let column = Column()
    let first = column.run([notch()])
    column.moveAndGlide(first[0], to: tall)
    let out = column.run([notch(gap: 200), notch(gap: 200), notch(gap: 30)])
    XCTAssertEqual(out, [.none, .none, .ease(540)])
  }

  func testUnusableDeltasDoNothing() {
    XCTAssertEqual(kinds(Column().run([notch(.nan), notch(0), swipe(.changed, .infinity)])), ["none", "none", "none"])
  }

  func testWheelingOnAtTheEdgeOfATallSectionMovesOnAfterABriefRestWithoutAPause() {
    let column = Column(range: tall, at: 720)
    var out: [WheelAction] = []
    for i in 0..<12 { out += column.run([notch(gap: i % 3 == 0 ? 160 : 60)]) }
    XCTAssertEqual(Array(out.prefix(2)), [.ease(760), .ease(800)])
    XCTAssertEqual(kinds(Array(out[2...4])), ["none", "none", "none"])
    XCTAssertEqual(out[5], .move(1))
  }

  func testARefusedNotchMoveNeverHoldsTheWheelForLong() {
    let column = Column()
    var moves = 0
    for _ in 0..<20 { if case .move = column.run([notch(gap: 60)])[0] { moves += 1 } }
    XCTAssertGreaterThanOrEqual(moves, 3)
  }

  func testARefusedSwipeMoveEndsWithItsGesture() {
    let column = Column()
    XCTAssertEqual(kinds(column.run([swipe(.began, -15), swipe(.changed, -15), swipe(.changed, -15), swipe(.ended, 0)])), ["place", "move1", "none", "none"])
    XCTAssertEqual(kinds(column.run([swipe(.began, -15, gap: 30), swipe(.changed, -15)])), ["place", "move1"])
  }

  func testAGestureWhoseEndNeverArrivesDoesNotOutliveTheNextOne() {
    let column = Column()
    XCTAssertEqual(kinds(column.run([swipe(.began, -15), swipe(.changed, -15), swipe(.changed, -15)])), ["place", "move1", "none"])
    XCTAssertEqual(kinds(column.run([swipe(.mayBegin, 0, gap: 30), swipe(.began, -15), swipe(.changed, -15)])), ["none", "place", "move1"])
  }

  func testAnEndlessPhaselessStreamMovesAgainOnceTheGlideIsNearlyDone() {
    let column = Column()
    var out: [WheelAction] = []
    for _ in 0..<80 { out += column.run([swipe(.none, -6, gap: 12)]) }
    XCTAssertGreaterThanOrEqual(out.filter { $0 == .move(1) }.count, 2)
  }

  func testAnEndlessPhaselessStreamAtTheEdgeOfATallSectionMovesOnAfterABriefRest() {
    let column = Column(range: tall, at: 780)
    var out: [WheelAction] = []
    for _ in 0..<60 { out += column.run([swipe(.none, -6, gap: 12)]) }
    XCTAssertEqual(Array(out.prefix(4)), [.place(786), .place(792), .place(798), .place(800)])
    XCTAssertTrue(out.contains(.move(1)))
  }

  func testABlockedForwardSwipeNeverPullsOrMoves() {
    let column = Column(range: WheelRange(lo: 500, hi: 500, forward: false))
    let out = column.run([swipe(.began, -10), swipe(.changed, -10), swipe(.changed, -30), swipe(.ended, 0), swipe(.none, -40, momentum: true)])
    XCTAssertEqual(kinds(out), ["none", "none", "none", "settle", "none"])
    XCTAssertEqual(column.at, 500)
  }

  func testABlockedForwardStillLetsTheSwipeGoBack() {
    XCTAssertEqual(kinds(Column(range: WheelRange(lo: 500, hi: 500, forward: false)).run([swipe(.began, 15), swipe(.changed, 15)])), ["place", "move-1"])
  }

  func testABlockedForwardNotchNeitherMovesNorHoldsTheWheel() {
    let column = Column(range: WheelRange(lo: 500, hi: 500, forward: false))
    XCTAssertEqual(kinds(column.run([notch(), notch(gap: 25), notch(-3, gap: 25)])), ["none", "none", "none"])
    XCTAssertEqual(column.run([notch(1, gap: 25)]), [.move(-1)])
  }

  func testATallSectionScrollsUpToABlockedEdgeAndStopsDead() {
    let column = Column(range: WheelRange(lo: 500, hi: 800, forward: false), at: 700)
    XCTAssertEqual(column.run([notch(), notch(gap: 30), notch(gap: 400), notch(gap: 400)]), [.ease(740), .ease(780), .ease(800), .none])
    let swiped = Column(range: WheelRange(lo: 500, hi: 800, forward: false), at: 780)
    XCTAssertEqual(swiped.run([swipe(.began, -30, gap: 500), swipe(.changed, -30), swipe(.none, -30, momentum: true)]), [.place(800), .none, .none])
  }

  func testMomentumTowardABlockedEdgeStopsAtIt() {
    let column = Column(range: WheelRange(lo: 500, hi: 800, forward: false), at: 760)
    XCTAssertEqual(column.run([swipe(.began, -20), swipe(.ended, 0), swipe(.none, -30, momentum: true), swipe(.none, -30, momentum: true)]), [.place(780), .none, .place(800), .none])
  }

  func testUnblockingMidGesturePullsAndMovesOn() {
    let column = Column(range: WheelRange(lo: 500, hi: 500, forward: false))
    XCTAssertEqual(kinds(column.run([swipe(.began, -10), swipe(.changed, -10)])), ["none", "none"])
    column.range.forward = true
    let out = column.run([swipe(.changed, -10), swipe(.changed, -20)])
    XCTAssertEqual(out[0], .place(504))
    XCTAssertEqual(out[1], .move(1))
  }

  func testBlockingMidPullReleasesThePullToTheEdge() {
    let column = Column()
    XCTAssertEqual(column.run([swipe(.began, -10)]), [.place(504)])
    column.range.forward = false
    XCTAssertEqual(column.run([swipe(.changed, -10), swipe(.changed, -10)]), [.place(500), .none])
  }
  func testATinyDeltaInsideATallSectionStaysPutInsteadOfPullingToTheEdge() {
    let out = Column(range: tall, at: 650).run([swipe(.began, -0.004), swipe(.changed, -0.004)])
    XCTAssertFalse(out.contains(.place(tall.hi)), "\(out)")
    XCTAssertFalse(out.contains(where: { if case .place(let y) = $0 { return y > 650.01 } else { return false } }), "\(out)")
  }

  func testAPauseInsideOneHeldSwipeDoesNotMoveASecondTime() {
    let out = Column().run([swipe(.began, -15), swipe(.changed, -15), swipe(.changed, -15, gap: 400), swipe(.changed, -15), swipe(.ended, 0)])
    XCTAssertEqual(kinds(out), ["place", "move1", "none", "none", "none"])
  }

  func testAPauseInPhaselessInputStillStartsAFreshGesture() {
    let out = Column().run([swipe(.none, -15), swipe(.none, -15), swipe(.none, -15, gap: 400), swipe(.none, -15)])
    XCTAssertEqual(kinds(out), ["place", "move1", "place", "move1"])
  }
}

