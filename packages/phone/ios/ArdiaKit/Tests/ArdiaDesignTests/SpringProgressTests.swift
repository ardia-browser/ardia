@testable import ArdiaDesign
import SwiftUI
import Testing

struct SpringProgressTests {
  static let springs = [
    Spring(response: 0.1, dampingRatio: 1),
    Spring(response: 0.12, dampingRatio: 1),
    Spring(response: 0.24, dampingRatio: 1),
  ]

  @Test(arguments: springs) func `progress starts at rest, never falls back and ends at the target`(spring: Spring) {
    #expect(spring.criticalProgress(at: 0) == 0)
    var previous = 0.0
    for time in stride(from: 0.0, through: 2 * spring.settlingDuration, by: 0.001) {
      let progress = spring.criticalProgress(at: time)
      #expect(progress >= previous)
      previous = progress
    }
    let longAfter = spring.criticalProgress(at: 10 * spring.duration)
    #expect(longAfter > 0.9999 && longAfter <= 1)
  }

  @Test(arguments: springs) func `a critically damped spring covers 1 − 2∕e of the way after one radian of its period`(spring: Spring) {
    let oneRadian = spring.duration / (2 * .pi)
    let expected = 1 - 2 / M_E
    #expect(abs(spring.criticalProgress(at: oneRadian) - expected) < 1e-9)
    #expect(abs(spring.time(toReach: CGFloat(expected)) - oneRadian) <= Spring.progressSearchStep)
    #expect(abs(spring.criticalProgress(at: 3 * oneRadian) - (1 - 4 / pow(M_E, 3))) < 1e-9)
  }

  @Test(arguments: springs) func `the time to reach a progress is the first sampled moment past it`(spring: Spring) {
    for target: CGFloat in [0.1, 0.3, 0.5, 0.8, 0.95] {
      let time = spring.time(toReach: target)
      #expect(time < spring.settlingDuration)
      #expect(spring.criticalProgress(at: time) >= Double(target))
      #expect(time == 0 || spring.criticalProgress(at: time - Spring.progressSearchStep) < Double(target))
    }
  }

  @Test(arguments: springs) func `asking for more than nearly there waits only until nearly there`(spring: Spring) {
    let nearlyThere = spring.time(toReach: Spring.fullyThere)
    #expect(spring.time(toReach: 1) == nearlyThere)
    #expect(spring.time(toReach: 5) == nearlyThere)
  }

  @Test(arguments: springs) func `no progress needs no wait`(spring: Spring) {
    #expect(spring.time(toReach: 0) == 0)
    #expect(spring.time(toReach: -0.5) == 0)
  }
}

struct RelativeVelocityTests {
  @Test func `a release speed becomes distances per second`() {
    #expect(Motion.relativeVelocity(600, over: 200) == 3)
    #expect(Motion.relativeVelocity(-600, over: 200) == -3)
  }

  @Test func `a fast release over a short distance is clamped both ways`() {
    #expect(Motion.relativeVelocity(10_000, over: 10) == 30)
    #expect(Motion.relativeVelocity(-10_000, over: 10) == -30)
    #expect(Motion.relativeVelocity(10_000, over: -10) == -30)
  }

  @Test func `no distance to travel hands over no speed`() {
    #expect(Motion.relativeVelocity(500, over: 0) == 0)
    #expect(Motion.relativeVelocity(500, over: 0.0005) == 0)
  }
}
