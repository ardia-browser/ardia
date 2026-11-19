import AppKit

enum LittleWindowFit {
  static func size(_ saved: CGSize, minimum: CGSize, visible: CGSize) -> CGSize {
    let side = { (saved: CGFloat, least: CGFloat, upper: CGFloat) in
      min(max(saved, least), min(max((upper * 0.8).rounded(), least), upper))
    }
    return CGSize(width: side(saved.width, minimum.width, visible.width), height: side(saved.height, minimum.height, visible.height))
  }

  static func cap(_ window: NSWindow, on screen: NSScreen) -> Bool {
    let visible = screen.visibleFrame
    let fitted = size(window.frame.size, minimum: window.minSize, visible: visible.size)
    guard fitted != window.frame.size else { return false }
    let frame = window.frame
    let origin = NSPoint(x: frame.minX, y: frame.maxY - fitted.height)
    window.setFrame(window.constrainFrameRect(NSRect(origin: origin, size: fitted), to: screen), display: false)
    return true
  }
}
