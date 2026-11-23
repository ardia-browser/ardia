import AppKit
import ArdiaCore
import ExpoModulesCore

final class FolderIconView: ExpoView {
  private struct Motion {
    let from: Double
    let to: Double
    let start: CFTimeInterval
    let duration: CFTimeInterval
  }

  var wantsOpen = false
  var palette = FolderPalette()

  private static var fullMotions: [String: [CGImage]] = [:]
  private static var fullMotionOrder: [String] = []
  private static let fullMotionsKept = 16

  private let art = CALayer()
  private var progress: Double = 0
  private var motion: Motion?
  private var shownOpen: Bool?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    wantsLayer = true
    NotificationCenter.default.addObserver(self, selector: #selector(interfaceScaleDidChange), name: .ArdiaInterfaceScaleDidChange, object: nil)
  }

  @objc private func interfaceScaleDidChange() {
    redraw()
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    redraw()
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window == nil { motion = nil }
    redraw()
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    redraw()
  }

  func propsDidUpdate() {
    defer { shownOpen = wantsOpen }
    let to: Double = wantsOpen ? 1 : 0
    guard let shownOpen, shownOpen != wantsOpen else {
      if shownOpen == nil { progress = to }
      redraw()
      return
    }
    let from = currentProgress()
    let duration = FolderArt.duration * abs(to - from)
    progress = to
    motion = nil
    if window != nil, duration > 0, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
      motion = Motion(from: from, to: to, start: CACurrentMediaTime(), duration: duration)
    }
    redraw()
  }

  private func currentProgress() -> Double {
    guard let motion else { return progress }
    let t = min(1, max(0, (CACurrentMediaTime() - motion.start) / motion.duration))
    return motion.from + (motion.to - motion.from) * t
  }

  private func redraw() {
    guard let layer, bounds.width > 0, bounds.height > 0 else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if art.superlayer !== layer { layer.addSublayer(art) }
    let side = min(bounds.width, bounds.height)
    let frame = backingAlignedRect(bounds.insetBy(dx: -side * FolderArt.bleed, dy: -side * FolderArt.bleed), options: .alignAllEdgesNearest)
    art.frame = frame
    let center = CGPoint(x: bounds.midX - frame.minX, y: isFlipped ? bounds.midY - frame.minY : frame.maxY - bounds.midY)
    let scale = backingDensity
    let palette = self.palette
    let image = { (progress: Double) in
      FolderArt.image(progress, size: frame.size, center: center, side: side, scale: scale, palette: palette)
    }
    let artKey = "\(frame.size.width)x\(frame.size.height)@\(scale):\(center.x),\(center.y):\(side):\(palette.artKey)"
    art.contentsScale = scale
    art.contents = image(progress)
    art.removeAnimation(forKey: "folder")
    if let motion {
      let elapsed = CACurrentMediaTime() - motion.start
      if elapsed < motion.duration { play(motion, elapsed: elapsed, artKey: artKey, image: image) } else { self.motion = nil }
    }
    CATransaction.commit()
  }

  private static func fullMotion(_ key: String, count: Int, image: (Double) -> CGImage?) -> [CGImage] {
    if let frames = fullMotions[key] { return frames }
    let frames = (0..<count).compactMap { i in image((Double(i) + 0.5) / Double(count)) }
    guard frames.count == count else { return frames }
    fullMotions[key] = frames
    fullMotionOrder.append(key)
    if fullMotionOrder.count > fullMotionsKept { fullMotions[fullMotionOrder.removeFirst()] = nil }
    return frames
  }

  private func play(_ motion: Motion, elapsed: CFTimeInterval, artKey: String, image: (Double) -> CGImage?) {
    let count = max(2, Int((motion.duration * FolderArt.framesPerSecond).rounded(.up)))
    let frames: [CGImage]
    if abs(motion.to - motion.from) == 1 {
      let opening = Self.fullMotion("\(artKey):\(count)", count: count, image: image)
      frames = motion.to > motion.from ? opening : opening.reversed()
    } else {
      frames = (0..<count).compactMap { i in image(motion.from + (motion.to - motion.from) * (Double(i) + 0.5) / Double(count)) }
    }
    let animation = CAKeyframeAnimation(keyPath: "contents")
    animation.values = frames
    animation.calculationMode = .discrete
    animation.duration = motion.duration
    animation.beginTime = art.convertTime(CACurrentMediaTime(), from: nil) - elapsed
    art.add(animation, forKey: "folder")
  }
}

private extension FolderPalette {
  var artKey: String {
    [stroke, face, insideTop, insideBottom].map { color in
      let srgb = color.usingColorSpace(.sRGB) ?? color
      return String(format: "%.4f,%.4f,%.4f,%.4f", srgb.redComponent, srgb.greenComponent, srgb.blueComponent, srgb.alphaComponent)
    }.joined(separator: ";")
  }
}

extension NSView {
  var backingDensity: CGFloat {
    guard window != nil else { return NSScreen.main?.backingScaleFactor ?? 2 }
    return convertToBacking(NSSize(width: 1, height: 1)).width
  }
}
