import AppKit
import ArdiaCore
import Carbon.HIToolbox
import ExpoModulesCore

final class SymbolView: ExpoView {
  private let imageView = NSImageView()
  private let glyph = CALayer()
  private var image: NSImage?
  var name = "questionmark" { didSet { update() } }
  var pointSize: Double = 14 { didSet { update() } }
  var weight = "regular" { didSet { update() } }
  var tint: NSColor? {
    didSet {
      imageView.contentTintColor = tint
      render()
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    imageView.imageScaling = .scaleProportionallyDown
    imageView.imageAlignment = .alignCenter
    imageView.autoresizingMask = [.width, .height]
    addSubview(imageView)
    glyph.actions = ["bounds": NSNull(), "position": NSNull(), "contents": NSNull(), "contentsScale": NSNull(), "opacity": NSNull()]
    glyph.contentsGravity = .resize
    NotificationCenter.default.addObserver(self, selector: #selector(interfaceScaleDidChange), name: .ArdiaInterfaceScaleDidChange, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(interfaceScaleDidChange), name: .ArdiaInterfaceScaleDidSettle, object: nil)
    update()
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

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

  private func update() {
    let weights: [String: NSFont.Weight] = [
      "light": .light, "regular": .regular, "medium": .medium, "semibold": .semibold, "bold": .bold,
    ]
    let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: weights[weight] ?? .regular)
    image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(config)
    imageView.image = image
    render()
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
