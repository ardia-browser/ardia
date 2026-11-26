import CoreGraphics
import Foundation

enum NewWindowPlacement: String {
  case cascade
  case beside
  case equal

  struct Result: Equatable {
    let windowFrame: CGRect
    let sourceFrame: CGRect?
  }

  static func resolve(
    mode: NewWindowPlacement,
    source: CGRect,
    visible: CGRect,
    minSize: CGSize,
    sourceMinSize: CGSize,
    sourceFixed: Bool
  ) -> Result? {
    guard mode != .cascade, !sourceFixed, visible.width > 0, visible.height > 0 else { return nil }
    let minW = max(minSize.width, 1)
    let minH = max(minSize.height, 1)
    switch mode {
    case .cascade:
      return nil
    case .equal:
      let sourceMinW = max(sourceMinSize.width, 1)
      let leftWidth = floor(visible.width / 2)
      let rightWidth = visible.width - leftWidth
      let sourceOnLeft = source.midX <= visible.midX
      let sourceWidth = sourceOnLeft ? leftWidth : rightWidth
      let windowWidth = sourceOnLeft ? rightWidth : leftWidth
      guard sourceWidth >= sourceMinW, windowWidth >= minW else { return nil }
      let leftFrame = CGRect(x: visible.minX, y: visible.minY, width: leftWidth, height: visible.height)
      let rightFrame = CGRect(x: visible.minX + leftWidth, y: visible.minY, width: rightWidth, height: visible.height)
      return Result(
        windowFrame: sourceOnLeft ? rightFrame : leftFrame,
        sourceFrame: sourceOnLeft ? leftFrame : rightFrame
      )
    case .beside:
      let sourceLeft = max(source.minX, visible.minX)
      let sourceRight = min(source.maxX, visible.maxX)
      let leftRoom = max(0, sourceLeft - visible.minX)
      let rightRoom = max(0, visible.maxX - sourceRight)
      let onRight = rightRoom >= leftRoom
      let room = onRight ? rightRoom : leftRoom
      guard room >= minW else { return nil }
      let width = min(max(source.width, minW), room)
      let height = min(max(source.height, minH), visible.height)
      let y = min(max(source.minY, visible.minY), visible.maxY - height)
      let x = onRight ? sourceRight : sourceLeft - width
      return Result(windowFrame: CGRect(x: x, y: y, width: width, height: height), sourceFrame: nil)
    }
  }
}
