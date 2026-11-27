import Foundation

struct ScreenOverlay {
  static let menuBarLayer = 24
  static let normalLayer = 0
  static let slackBundle = "com.tinyspeck.slackmacgap"

  let bounds: CGRect
  let layer: Int
  let fromSlack: Bool
  var capturable = true

  func passesOver(_ point: CGPoint, displays: [CGRect], windows: [CGRect], margin: CGFloat) -> Bool {
    guard fromSlack, bounds.contains(point) else { return false }
    let rings = { (frame: CGRect) in frame.contains(point) && bounds.contains(frame.insetBy(dx: margin, dy: margin)) }
    if layer > Self.menuBarLayer { return displays.contains(where: rings) || windows.contains(where: rings) }
    guard layer > Self.normalLayer || !capturable else { return false }
    return windows.contains { rings($0) && encloses($0) && $0.insetBy(dx: -margin, dy: -margin).contains(bounds) }
  }

  private func encloses(_ frame: CGRect) -> Bool {
    bounds.minX < frame.minX && bounds.minY < frame.minY && bounds.maxX > frame.maxX && bounds.maxY > frame.maxY
  }
}
