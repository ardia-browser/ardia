import Foundation

public struct PagePinch: Equatable, Sendable {
  public enum Ending: Sendable {
    case ended
    case cancelled
    case failed
  }

  public struct Moment: Equatable, Sendable {
    public var page: UUID
    public var navigation: Int
    public var zoomScale: Double
    public var minimumZoomScale: Double
    public var isVisible: Bool
    public var isLoading: Bool

    public init(page: UUID, navigation: Int, zoomScale: Double, minimumZoomScale: Double, isVisible: Bool, isLoading: Bool) {
      self.page = page
      self.navigation = navigation
      self.zoomScale = zoomScale
      self.minimumZoomScale = minimumZoomScale
      self.isVisible = isVisible
      self.isLoading = isLoading
    }

    var restsAtMinimumZoom: Bool { zoomScale <= minimumZoomScale * (1 + PagePinch.zoomTolerance) }
  }

  public static let commitScale = 0.5
  public static let engageScale = 0.9
  public static let flickVelocity = -1.0
  public static let outwardTolerance = 1.04
  public static let zoomTolerance = 0.01
  public static let bandFloor = 0.95
  public static let bandReach = 0.1
  public static let bandCoefficient = 0.55

  public static func rubberBand(_ value: Double, in range: ClosedRange<Double>, reach: Double, coefficient: Double = bandCoefficient) -> Double {
    let held = min(max(value, range.lowerBound), range.upperBound)
    guard held != value, reach > 0 else { return value }
    let give = reach * (1 - 1 / (abs(held - value) * coefficient / reach + 1))
    return value < held ? held - give : held + give
  }

  public static func shownScale(for scale: Double) -> Double {
    guard scale.isFinite, scale < 1 else { return 1 }
    return rubberBand(max(scale, 0), in: bandFloor...1, reach: bandReach)
  }

  public static func shownWidthScale(for scale: Double) -> Double { 1 - 0.5 * (1 - shownScale(for: scale)) }

  public static func foldProgress(for scale: Double) -> Double {
    guard scale.isFinite else { return 0 }
    return min(max((engageScale - scale) * 1.5, 0), 1)
  }

  public static func glow(for scale: Double) -> Double {
    guard scale.isFinite else { return 0 }
    return min(max((engageScale - scale) * 10, 0), 1)
  }

  public static func isEngaged(at scale: Double) -> Bool { scale.isFinite && scale < engageScale }

  public let page: UUID
  public let navigation: Int
  public private(set) var smallestScale = 1.0
  public private(set) var largestScale = 1.0
  public private(set) var lastScale = 1.0

  public init?(at moment: Moment, scale: Double = 1) {
    guard moment.isVisible, !moment.isLoading, moment.restsAtMinimumZoom, scale <= Self.outwardTolerance else { return nil }
    page = moment.page
    navigation = moment.navigation
    moved(to: scale)
  }

  public mutating func moved(to scale: Double) {
    guard scale.isFinite, scale > 0 else { return }
    lastScale = scale
    smallestScale = min(smallestScale, scale)
    largestScale = max(largestScale, scale)
  }

  public var wentOutward: Bool { largestScale > Self.outwardTolerance }

  public func fires(_ ending: Ending, velocity: Double = 0, at moment: Moment) -> Bool {
    guard ending == .ended, !wentOutward else { return false }
    guard lastScale < Self.commitScale || (lastScale < Self.engageScale && velocity < Self.flickVelocity) else { return false }
    guard moment.page == page, moment.navigation == navigation, moment.isVisible, !moment.isLoading else { return false }
    return moment.restsAtMinimumZoom
  }
}
