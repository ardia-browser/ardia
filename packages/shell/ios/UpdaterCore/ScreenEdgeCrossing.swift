import Foundation

struct ScreenEdgeCrossing {
  static let flingSpeed: CGFloat = 1200
  static let pushDistance: CGFloat = 64
  static let speedWindow: TimeInterval = 0.05

  private var samples: [(x: CGFloat, at: TimeInterval)] = []
  private(set) var pushed: CGFloat = 0

  mutating func track(_ point: CGPoint, at time: TimeInterval) {
    samples.removeAll { time - $0.at > Self.speedWindow || $0.at > time }
    samples.append((point.x, time))
  }

  mutating func forget() {
    samples = []
    pushed = 0
  }

  func speed(right: Bool) -> CGFloat {
    guard let first = samples.first, let last = samples.last, last.at > first.at else { return 0 }
    return (right ? last.x - first.x : first.x - last.x) / CGFloat(last.at - first.at)
  }

  func isFling(right: Bool) -> Bool {
    speed(right: right) >= Self.flingSpeed
  }

  mutating func startPush() {
    pushed = 0
  }

  mutating func push(by overshoot: CGFloat) -> Bool {
    pushed += max(0, overshoot)
    return pushed >= Self.pushDistance
  }
}
