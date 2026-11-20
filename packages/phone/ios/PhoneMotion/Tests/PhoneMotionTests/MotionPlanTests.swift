import QuartzCore
import Testing
@testable import PhoneMotion

private let depart = MotionCurve.timing(seconds: 0.2, controlPoints: [0.2, 0, 0, 1])
private let expand = MotionCurve.spring(response: 0.18, dampingFraction: 1)
private let departed = MotionValues(opacity: 0, translateY: -120)

private final class Ends {
  var seen: [Bool] = []
}

private func runner(_ ends: Ends) -> MotionRunner {
  let made = MotionRunner(layer: CALayer())
  made.onEnd = { ends.seen.append($0) }
  return made
}

private func held(_ body: () throws -> Void) rethrows {
  CATransaction.begin()
  defer { CATransaction.commit() }
  try body()
}

private func stopAll(_ runner: MotionRunner, finished: Bool = true) {
  for channel in MotionChannel.allCases {
    guard let animation = runner.layer.animation(forKey: channel.key) else { continue }
    animation.delegate?.animationDidStop?(animation, finished: finished)
  }
}

@MainActor
@Suite(.serialized)
struct MotionPlanTests {
  @Test func theFirstValueIsShownWithoutMotionOrAnEnd() {
    let ends = Ends()
    let motion = runner(ends)
    motion.show(departed, curve: depart, animates: true)
    #expect(motion.layer.animationKeys() == nil)
    #expect(motion.layer.opacity == 0)
    #expect(motion.layer.value(forKeyPath: "transform.translation.y") as? CGFloat == -120)
    #expect(ends.seen.isEmpty)
  }

  @Test func mainsDepartCurveReachesCoreAnimationAndTheEndStateIsKept() throws {
    try held {
      let ends = Ends()
      let motion = runner(ends)
      motion.show(MotionValues(), curve: depart, animates: true)
      motion.show(departed, curve: depart, animates: true)
      let fade = try #require(motion.layer.animation(forKey: MotionChannel.opacity.key) as? CABasicAnimation)
      let lift = try #require(motion.layer.animation(forKey: MotionChannel.translateY.key) as? CABasicAnimation)
      #expect(fade.duration == 0.2)
      #expect(fade.fromValue as? CGFloat == 1)
      #expect(fade.toValue as? CGFloat == 0)
      #expect(lift.toValue as? CGFloat == -120)
      var points = [Float](repeating: 0, count: 2)
      fade.timingFunction?.getControlPoint(at: 1, values: &points)
      #expect(points == [0.2, 0])
      fade.timingFunction?.getControlPoint(at: 2, values: &points)
      #expect(points == [0, 1])
      #expect(motion.layer.animation(forKey: MotionChannel.scale.key) == nil, "a channel that doesn't change gets no animation")
      #expect(motion.layer.opacity == 0, "the model layer holds the end state, so it stays when the animation is removed")
      #expect(motion.layer.value(forKeyPath: "transform.translation.y") as? CGFloat == -120)
    }
  }

  @Test func mainsSpringTokensBecomeACriticallyDampedSpring() throws {
    try held {
      let motion = runner(Ends())
      motion.show(MotionValues(scale: 0.9), curve: expand, animates: true)
      motion.show(MotionValues(scale: 1), curve: expand, animates: true)
      let spring = try #require(motion.layer.animation(forKey: MotionChannel.scale.key) as? CASpringAnimation)
      #expect(abs(spring.perceptualDuration - 0.18) < 0.001)
      #expect(abs(spring.bounce) < 0.001)
      #expect(spring.duration == spring.settlingDuration)
      #expect(spring.toValue as? CGFloat == 1)
    }
  }

  @Test func theCardsCornersGrowToTheDisplaysWithTheSameCurve() throws {
    try held {
      let ends = Ends()
      let motion = runner(ends)
      motion.show(MotionValues(scale: 0.8, cornerRadius: 28), curve: expand, animates: true)
      #expect(motion.layer.cornerRadius == 28)
      #expect(motion.layer.cornerCurve == .continuous)
      #expect(motion.layer.masksToBounds, "the corners clip the card's page")
      motion.show(MotionValues(scale: 1, cornerRadius: 55), curve: expand, animates: true)
      let corners = try #require(motion.layer.animation(forKey: MotionChannel.cornerRadius.key) as? CASpringAnimation)
      let growth = try #require(motion.layer.animation(forKey: MotionChannel.scale.key) as? CASpringAnimation)
      #expect(corners.fromValue as? CGFloat == 28)
      #expect(corners.toValue as? CGFloat == 55)
      #expect(corners.perceptualDuration == growth.perceptualDuration)
      #expect(motion.layer.cornerRadius == 55)
      stopAll(motion)
      #expect(ends.seen == [true], "the end waits for the corners too")
    }
  }

  @Test func leavingOutTheCornersNeverTouchesTheLayersOwn() {
    held {
      let motion = runner(Ends())
      motion.layer.cornerRadius = 12
      motion.show(MotionValues(), curve: depart, animates: true)
      motion.show(departed, curve: depart, animates: true)
      #expect(motion.layer.cornerRadius == 12)
      #expect(!motion.layer.masksToBounds)
      #expect(motion.layer.animation(forKey: MotionChannel.cornerRadius.key) == nil)
    }
  }

  @Test func aStartPoseMovesToTheTargetInTheSameMount() throws {
    try held {
      let ends = Ends()
      let motion = runner(ends)
      motion.show(MotionValues(scale: 1, cornerRadius: 55), curve: expand, animates: true, startingAt: MotionValues(translateY: 240, scale: 0.4, cornerRadius: 28))
      let growth = try #require(motion.layer.animation(forKey: MotionChannel.scale.key) as? CASpringAnimation)
      let lift = try #require(motion.layer.animation(forKey: MotionChannel.translateY.key) as? CASpringAnimation)
      let corners = try #require(motion.layer.animation(forKey: MotionChannel.cornerRadius.key) as? CASpringAnimation)
      #expect(growth.fromValue as? CGFloat == 0.4)
      #expect(growth.toValue as? CGFloat == 1)
      #expect(lift.fromValue as? CGFloat == 240)
      #expect(corners.fromValue as? CGFloat == 28)
      #expect(motion.layer.value(forKeyPath: "transform.scale.x") as? CGFloat == 1, "the model layer holds the end state")
      stopAll(motion)
      #expect(ends.seen == [true], "a move started from a start pose reports its end")
    }
  }

  @Test func aStartPoseCountsOnlyAtTheFirstMount() {
    held {
      let motion = runner(Ends())
      motion.show(MotionValues(scale: 1), curve: expand, animates: true)
      motion.show(MotionValues(scale: 1), curve: expand, animates: true, startingAt: MotionValues(scale: 0.4))
      #expect(motion.layer.animationKeys() == nil, "a mounted view ignores a later start pose")
      let still = runner(Ends())
      still.show(MotionValues(scale: 1), curve: expand, animates: true, startingAt: MotionValues(scale: 1))
      #expect(still.layer.animationKeys() == nil, "a start pose equal to the target is shown without motion")
    }
  }

  @Test func theEndFiresOnceWhenEveryChannelHasStopped() {
    held {
      let ends = Ends()
      let motion = runner(ends)
      motion.show(MotionValues(), curve: depart, animates: true)
      motion.show(departed, curve: depart, animates: true)
      #expect(motion.layer.animationKeys()?.count == 2)
      let fade = motion.layer.animation(forKey: MotionChannel.opacity.key)!
      fade.delegate?.animationDidStop?(fade, finished: true)
      #expect(ends.seen.isEmpty, "one channel still moving")
      stopAll(motion)
      #expect(ends.seen == [true])
      stopAll(motion)
      #expect(ends.seen == [true], "a late stop doesn't fire it again")
    }
  }

  @Test func aSupersededMoveReportsNothingAndTheNewOneReportsOnce() {
    held {
      let ends = Ends()
      let motion = runner(ends)
      motion.show(MotionValues(), curve: depart, animates: true)
      motion.show(departed, curve: depart, animates: true)
      let old = motion.layer.animation(forKey: MotionChannel.opacity.key)!
      motion.show(MotionValues(opacity: 1, translateY: -60), curve: depart, animates: true)
      old.delegate?.animationDidStop?(old, finished: false)
      #expect(ends.seen.isEmpty)
      stopAll(motion)
      #expect(ends.seen == [true])
    }
  }

  @Test func withoutMotionTheEndStateLandsAtOnceAndReportsFinished() {
    let ends = Ends()
    let motion = runner(ends)
    motion.show(MotionValues(), curve: depart, animates: true)
    motion.show(departed, curve: depart, animates: false)
    #expect(motion.layer.animationKeys() == nil)
    #expect(motion.layer.opacity == 0)
    #expect(ends.seen == [true])
  }

  @Test func theSameTargetAgainDoesNothing() {
    let ends = Ends()
    let motion = runner(ends)
    motion.show(MotionValues(), curve: depart, animates: true)
    motion.show(departed, curve: depart, animates: true)
    let move = motion.move
    motion.show(departed, curve: depart, animates: true)
    #expect(motion.move == move)
    #expect(ends.seen.isEmpty)
  }
}
