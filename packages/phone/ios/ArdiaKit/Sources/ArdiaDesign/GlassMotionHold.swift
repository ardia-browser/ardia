import CoreGraphics
import Foundation

public struct GlassMotionHold: Sendable {
  public static let quiet: TimeInterval = 0.12
  public static let arrival: TimeInterval = 0.45
  public static let largeShare: CGFloat = 0.2
  public static let tolerance: CGFloat = 0.5

  public private(set) var heldUntil: TimeInterval = 0
  private var placements: [CGRect]?

  public init() {}

  public func holds(now: TimeInterval) -> Bool { now < heldUntil }

  @discardableResult
  public mutating func observe(_ frames: [CGRect], in space: CGRect, now: TimeInterval) -> Bool {
    let large = Self.large(frames, in: space)
    guard let reference = placements else {
      placements = large
      return false
    }
    guard Self.moved(from: reference, to: large) else { return false }
    placements = large
    heldUntil = max(heldUntil, now + Self.quiet)
    return true
  }

  public mutating func arrive(now: TimeInterval) {
    heldUntil = max(heldUntil, now + Self.arrival)
  }

  static func large(_ frames: [CGRect], in space: CGRect) -> [CGRect] {
    let area = max(space.width * space.height, 1)
    return frames.filter { !$0.isNull && $0.width * $0.height >= area * largeShare }
  }

  static func moved(from old: [CGRect], to new: [CGRect]) -> Bool {
    guard old.count == new.count else { return true }
    return zip(old, new).contains { a, b in
      abs(a.minX - b.minX) > tolerance || abs(a.minY - b.minY) > tolerance || abs(a.width - b.width) > tolerance || abs(a.height - b.height) > tolerance
    }
  }
}
