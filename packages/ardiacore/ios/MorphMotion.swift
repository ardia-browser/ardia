import Foundation
import QuartzCore

struct MorphFrame {
  let target: CFTimeInterval
  let interval: CFTimeInterval

  init(target: CFTimeInterval, interval: CFTimeInterval) {
    self.target = target
    self.interval = max(0, interval)
  }

  init(_ link: CADisplayLink) {
    self.init(target: link.targetTimestamp, interval: link.targetTimestamp - link.timestamp)
  }
}

struct RoomSpring {
  static let omega = 2 * Double.pi / 0.25
  static let rest = 0.25

  let from: Double
  let target: Double
  let velocity: Double
  let start: CFTimeInterval

  func state(at time: CFTimeInterval) -> (offset: Double, velocity: Double) {
    let t = max(0, time - start)
    let x0 = from - target
    let b = velocity + Self.omega * x0
    let decay = exp(-Self.omega * t)
    return ((x0 + b * t) * decay, (velocity - Self.omega * b * t) * decay)
  }

  func settled(at time: CFTimeInterval) -> Bool {
    let now = state(at: time)
    return abs(now.offset) < Self.rest && abs(now.velocity) < Self.rest * 10
  }

  func width(at time: CFTimeInterval) -> Double { target + state(at: time).offset }
}

struct MorphFrameCounter {
  enum Kind { case first, onTime, late }

  private var last: CFTimeInterval?

  mutating func drawn(_ frame: MorphFrame) -> Kind {
    defer { last = frame.target }
    guard let last, frame.target > last else { return .first }
    return frame.interval > 0 && frame.target - last > frame.interval * 1.5 ? .late : .onTime
  }

  mutating func skipped() { last = nil }
}
