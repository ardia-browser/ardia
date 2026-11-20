import AppKit
import ArdiaCore
import Carbon.HIToolbox
import ExpoModulesCore

private enum SymbolReplace {
  static let outDuration = 0.16
  static let outScale = 0.5
  static let inScale = 0.5
  static let stiffness: CGFloat = 380
  static let damping: CGFloat = 26
  static let fadeDuration = 0.15
}

private struct GlyphSnapshot {
  let contents: Any?
  let frame: CGRect
  let scale: CGFloat
  let opacity: Float

  init(_ layer: CALayer) {
    contents = layer.contents
    frame = layer.frame
    scale = layer.contentsScale
    opacity = layer.opacity
  }
}

final class SymbolView: ExpoView {
  private let imageView = NSImageView()
  private let glyph = CALayer()
  private var image: NSImage?
  var name = "questionmark" {
    didSet {
      if name != oldValue { update(replacing: replace) }
    }
  }
  var replace = false
  var pointSize: Double = 14 { didSet { update() } }
  var weight = "regular" { didSet { update() } }
  var bounce = 0 {
    didSet {
      if bounce != oldValue { playBounce() }
    }
  }
  var tint: NSColor? {
    didSet {
      imageView.contentTintColor = tint
      if !SymbolView.sameColor(tint, oldValue) { update() } else { render() }
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    imageView.imageScaling = .scaleProportionallyDown
    imageView.imageAlignment = .alignCenter
    imageView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(imageView)
    glyph.actions = ["bounds": NSNull(), "position": NSNull(), "contents": NSNull(), "contentsScale": NSNull(), "opacity": NSNull()]
    glyph.contentsGravity = .resize
    NotificationCenter.default.addObserver(self, selector: #selector(interfaceScaleDidChange), name: .ArdiaInterfaceScaleDidChange, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(interfaceScaleDidChange), name: .ArdiaInterfaceScaleDidSettle, object: nil)
    update()
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func layout() {
    super.layout()
    imageView.frame = bounds
  }

  private static func sameColor(_ a: NSColor?, _ b: NSColor?) -> Bool {
    guard let a, let b else { return a == nil && b == nil }
    guard let x = a.usingColorSpace(.sRGB), let y = b.usingColorSpace(.sRGB) else { return a == b }
    let close = { (p: CGFloat, q: CGFloat) in abs(p - q) < 0.002 }
    return close(x.redComponent, y.redComponent) && close(x.greenComponent, y.greenComponent) && close(x.blueComponent, y.blueComponent) && close(x.alphaComponent, y.alphaComponent)
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    imageView.frame = bounds
    render()
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    render()
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    render()
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    render()
  }

  @objc private func interfaceScaleDidChange() {
    update()
  }

  private func playBounce() {
    guard window != nil, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
    if !imageView.isHidden {
      imageView.removeAllSymbolEffects(options: .nonRepeating, animated: false)
      imageView.addSymbolEffect(.bounce.down.byLayer, options: .nonRepeating)
      return
    }
    let squash = CAKeyframeAnimation(keyPath: "transform.scale")
    squash.values = [1, 0.8, 1.1, 0.99, 1]
    squash.keyTimes = [0, 0.25, 0.53, 0.78, 1]
    squash.timingFunctions = Array(repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: 4)
    squash.duration = 0.56
    glyph.add(squash, forKey: "bounce")
  }

  private func update(replacing: Bool = false) {
    let weights: [String: NSFont.Weight] = [
      "light": .light, "regular": .regular, "medium": .medium, "semibold": .semibold, "bold": .bold,
    ]
    var config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: weights[weight] ?? .regular)
    if let tint { config = config.applying(NSImage.SymbolConfiguration(paletteColors: [tint])) }
    let next = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(config)
    let animates = replacing && window != nil && image != nil && next != nil
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let shown = GlyphSnapshot(glyph)
    image = next
    if animates, let next, !imageView.isHidden, !calm {
      if #available(macOS 15.0, *) {
        imageView.setSymbolImage(next, contentTransition: .replace.magic(fallback: .replace.downUp.byLayer))
      } else {
        imageView.setSymbolImage(next, contentTransition: .replace.downUp.byLayer)
      }
    } else {
      if animates, !imageView.isHidden { crossfade(imageView.layer) }
      imageView.image = next
    }
    render()
    if animates, imageView.isHidden { replaceGlyph(from: shown, calm: calm) }
  }

  private func crossfade(_ target: CALayer?) {
    let fade = CATransition()
    fade.type = .fade
    fade.duration = SymbolReplace.fadeDuration
    target?.add(fade, forKey: "replace")
  }

  private func replaceGlyph(from shown: GlyphSnapshot, calm: Bool) {
    guard let layer, let contents = shown.contents else { return }
    let ghost = CALayer()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    ghost.contents = contents
    ghost.frame = shown.frame
    ghost.contentsScale = shown.scale
    ghost.contentsGravity = .resize
    ghost.opacity = 0
    layer.insertSublayer(ghost, below: glyph)
    CATransaction.commit()
    CATransaction.begin()
    CATransaction.setCompletionBlock { ghost.removeFromSuperlayer() }
    let out = CAAnimationGroup()
    out.duration = calm ? SymbolReplace.fadeDuration : SymbolReplace.outDuration
    out.timingFunction = CAMediaTimingFunction(name: .easeOut)
    out.animations = [Self.ramp("opacity", from: shown.opacity, to: 0)] + (calm ? [] : [Self.ramp("transform.scale", from: 1, to: SymbolReplace.outScale)])
    ghost.add(out, forKey: "replace")
    if calm {
      let fadeIn = Self.ramp("opacity", from: 0, to: glyph.opacity)
      fadeIn.duration = SymbolReplace.fadeDuration
      glyph.add(fadeIn, forKey: "replace")
    } else {
      let grow = CASpringAnimation(keyPath: "transform.scale")
      grow.fromValue = SymbolReplace.inScale
      grow.toValue = 1
      grow.mass = 1
      grow.stiffness = SymbolReplace.stiffness
      grow.damping = SymbolReplace.damping
      grow.duration = grow.settlingDuration
      let fadeIn = Self.ramp("opacity", from: 0, to: glyph.opacity)
      fadeIn.duration = SymbolReplace.outDuration
      fadeIn.timingFunction = CAMediaTimingFunction(name: .easeOut)
      let incoming = CAAnimationGroup()
      incoming.duration = grow.duration
      incoming.animations = [grow, fadeIn]
      glyph.add(incoming, forKey: "replace")
    }
    CATransaction.commit()
  }

  private static func ramp(_ keyPath: String, from: Any, to: Any) -> CABasicAnimation {
    let ramp = CABasicAnimation(keyPath: keyPath)
    ramp.fromValue = from
    ramp.toValue = to
    return ramp
  }

  private func render() {
    guard let layer else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    if glyph.superlayer !== layer { layer.addSublayer(glyph) }
    let drawsAtWindowScale = window.map { abs(backingDensity - $0.backingScaleFactor) < 0.001 } ?? true
    imageView.isHidden = !drawsAtWindowScale
    guard !drawsAtWindowScale, let image, bounds.width > 0, bounds.height > 0, image.size.width > 0, image.size.height > 0 else {
      glyph.contents = nil
      return
    }
    let fit = min(1, bounds.width / image.size.width, bounds.height / image.size.height)
    let size = NSSize(width: image.size.width * fit, height: image.size.height * fit)
    let drawn = NSRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
    let cell = backingAlignedRect(drawn, options: [.alignMinXOutward, .alignMinYOutward, .alignMaxXOutward, .alignMaxYOutward])
    let pixels = convertToBacking(cell).size
    let wide = Int(pixels.width.rounded()), high = Int(pixels.height.rounded())
    guard wide > 0, high > 0,
      let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: wide, pixelsHigh: high, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: rep)
    else {
      glyph.contents = nil
      return
    }
    let density = CGFloat(wide) / cell.width
    let flipped = isFlipped
    var opacity: Float = 1
    effectiveAppearance.performAsCurrentDrawingAppearance {
      let resolved = (tint ?? .labelColor).usingColorSpace(.sRGB) ?? .black
      opacity = Float(resolved.alphaComponent)
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = context
      let cg = context.cgContext
      cg.scaleBy(x: density, y: CGFloat(high) / cell.height)
      let originY = flipped ? cell.maxY - drawn.maxY : drawn.minY - cell.minY
      let target = NSRect(x: drawn.minX - cell.minX, y: originY, width: drawn.width, height: drawn.height)
      image.draw(in: target, from: .zero, operation: .sourceOver, fraction: 1)
      resolved.withAlphaComponent(1).set()
      target.fill(using: .sourceAtop)
      NSGraphicsContext.restoreGraphicsState()
    }
    glyph.frame = cell
    glyph.contentsScale = density
    glyph.opacity = opacity
    glyph.contents = rep.cgImage
  }
}
