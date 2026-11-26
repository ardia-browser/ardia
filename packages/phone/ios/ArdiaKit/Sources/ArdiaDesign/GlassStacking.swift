import CoreGraphics

public enum GlassStacking {
  public static func coversOpaquely(isPage: Bool, alpha: Double, fillAlpha: Double, masked: Bool) -> Bool {
    !isPage && !masked && alpha >= 1 && fillAlpha >= 1
  }

  public static func reach(bounds: CGRect, clips: Bool, children: [CGRect]) -> CGRect {
    guard !clips else { return bounds }
    return children.reduce(bounds.isEmpty ? CGRect.null : bounds) { $0.union($1) }
  }

  public struct Sibling: Equatable, Sendable {
    public var index: Int
    public var zPosition: Double

    public init(index: Int, zPosition: Double) {
      self.index = index
      self.zPosition = zPosition
    }
  }

  public static func drawOrder(_ siblings: [Sibling]) -> [Sibling] {
    siblings.sorted { ($0.zPosition, $0.index) < ($1.zPosition, $1.index) }
  }

  public static func below(_ child: Sibling, among siblings: [Sibling]) -> [Int] {
    drawOrder(siblings).filter { ($0.zPosition, $0.index) < (child.zPosition, child.index) }.map(\.index)
  }

  public struct Coverage: Equatable, Sendable {
    public var rect: CGRect
    public var radius: CGFloat
    public var axisAligned: Bool
    public var opaque: Bool
    public var clips: [CGRect]

    public init(rect: CGRect, radius: CGFloat = 0, axisAligned: Bool = true, opaque: Bool, clips: [CGRect] = []) {
      self.rect = rect
      self.radius = radius
      self.axisAligned = axisAligned
      self.opaque = opaque
      self.clips = clips
    }

    public func covers(_ wanted: CGRect) -> Bool {
      guard opaque, axisAligned, !wanted.isNull else { return false }
      let corner = max(radius, 0)
      let bands = corner > 0 ? [rect.insetBy(dx: corner, dy: 0), rect.insetBy(dx: 0, dy: corner)] : [rect]
      return bands.contains { band in
        let solid = clips.reduce(band) { $0.intersection($1) }
        return !solid.isNull && solid.contains(wanted)
      }
    }
  }

  public static func opaqueFloor(_ pieces: [Coverage], covering wanted: CGRect) -> Int? {
    pieces.lastIndex { $0.covers(wanted) }
  }
}
