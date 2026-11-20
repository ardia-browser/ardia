import Foundation

struct ScreenEdgeCrossing {
  static let reach: CGFloat = 96
  static let returnWithin: TimeInterval = 0.7

  enum Move: Equatable {
    case crossed
    case returned
  }

  private var wasInside = false
  private var leftAt: TimeInterval?
  func awaitingReturn(at time: TimeInterval) -> Bool { leftAt.map { time - $0 <= Self.returnWithin } ?? false }

  mutating func track(past: CGFloat, at time: TimeInterval) -> Move? {
    let inside = past <= 0
    defer { wasInside = inside }
    if !inside {
      if past > Self.reach { leftAt = nil }
      guard wasInside else { return nil }
      if past <= Self.reach { leftAt = time }
      return .crossed
    }
    guard let since = leftAt else { return nil }
    leftAt = nil
    return time - since <= Self.returnWithin && past >= -Self.reach ? .returned : nil
  }
}
