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

  public static let triggerScale = 0.7
  public static let outwardTolerance = 1.04
  public static let reversalTolerance = 0.12
  public static let zoomTolerance = 0.01

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

  public func fires(_ ending: Ending, at moment: Moment) -> Bool {
    guard ending == .ended, !wentOutward else { return false }
    guard lastScale <= Self.triggerScale, lastScale <= smallestScale + Self.reversalTolerance else { return false }
    guard moment.page == page, moment.navigation == navigation, moment.isVisible, !moment.isLoading else { return false }
    return moment.restsAtMinimumZoom
  }
}
