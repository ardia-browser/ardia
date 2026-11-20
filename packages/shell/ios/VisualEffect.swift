import AppKit
import Carbon.HIToolbox
import ExpoModulesCore
import QuartzCore

final class VisualEffect: ExpoView {
  let effect = NSVisualEffectView()
  var cornerRadius: Double = 0 { didSet { applyCorners() } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    effect.state = .active
    effect.blendingMode = .withinWindow
    effect.material = .hudWindow
    effect.wantsLayer = true
    addSubview(effect)
  }

  func setMaterial(_ name: String) {
    let materials: [String: NSVisualEffectView.Material] = [
      "hudWindow": .hudWindow, "popover": .popover, "menu": .menu, "sidebar": .sidebar,
      "headerView": .headerView, "sheet": .sheet, "windowBackground": .windowBackground,
      "underWindowBackground": .underWindowBackground, "contentBackground": .contentBackground,
      "fullScreenUI": .fullScreenUI, "toolTip": .toolTip, "titlebar": .titlebar, "selection": .selection,
    ]
    effect.material = materials[name] ?? .hudWindow
  }

  private func applyCorners() {
    effect.layer?.cornerRadius = cornerRadius
    effect.layer?.cornerCurve = .continuous
    effect.layer?.masksToBounds = cornerRadius > 0
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    effect.frame = bounds
    applyCorners()
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}


final class ProgressiveBlur: ExpoView {
  private let backdrop: CALayer = ProgressiveBlur.makeBackdrop()
  private var maskSize: CGSize = .zero
  var radius: Double = 12 { didSet { if radius != oldValue { applyFilter() } } }
  var solidShare: Double = 0.25 { didSet { if solidShare != oldValue { applyFilter() } } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    wantsLayer = true
    layerUsesCoreImageFilters = true
    backdrop.masksToBounds = true
    backdrop.actions = ["bounds": NSNull(), "position": NSNull(), "filters": NSNull(), "hidden": NSNull()]
    layer?.addSublayer(backdrop)
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(displayOptionsChanged), name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
    displayOptionsChanged()
  }

  deinit { NSWorkspace.shared.notificationCenter.removeObserver(self) }

  @objc private func displayOptionsChanged() {
    backdrop.isHidden = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
  }

  private static func makeBackdrop() -> CALayer {
    guard let type = NSClassFromString("CABackdropLayer") as? CALayer.Type else { return CALayer() }
    let layer = type.init()
    return layer
  }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    backdrop.frame = bounds
    backdrop.setValue(window?.backingScaleFactor ?? 2, forKey: "scale")
    CATransaction.commit()
    if bounds.size != maskSize { applyFilter() }
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    maskSize = .zero
    needsLayout = true
  }

  private func applyFilter() {
    maskSize = bounds.size
    guard bounds.width > 0, bounds.height > 0 else { return }
    if let filter = ProgressiveBlur.variableBlur(radius: radius, mask: gradientMask()) {
      backdrop.filters = [filter]
      return
    }
    let blur = CIFilter(name: "CIGaussianBlur")
    blur?.setValue(radius / 2, forKey: kCIInputRadiusKey)
    backdrop.backgroundFilters = blur.map { [$0] }
    let fade = CAGradientLayer()
    fade.frame = bounds
    fade.colors = [NSColor.black.cgColor, NSColor.black.cgColor, NSColor.clear.cgColor]
    fade.locations = [0, NSNumber(value: solidShare), 1]
    fade.startPoint = CGPoint(x: 0.5, y: isFlipped ? 0 : 1)
    fade.endPoint = CGPoint(x: 0.5, y: isFlipped ? 1 : 0)
    backdrop.mask = fade
  }

  private func gradientMask() -> CGImage? {
    let height = max(1, Int(bounds.height.rounded(.up)))
    guard let context = CGContext(data: nil, width: 1, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue) else { return nil }
    let solid = Double(height) * solidShare
    for row in 0..<height {
      let fromTop = Double(height - 1 - row)
      let alpha = fromTop <= solid ? 1 : max(0, 1 - (fromTop - solid) / max(1, Double(height) - solid))
      context.setAlpha(1)
      context.setFillColor(gray: 0, alpha: CGFloat(alpha * alpha * (3 - 2 * alpha)))
      context.fill(CGRect(x: 0, y: row, width: 1, height: 1))
    }
    return context.makeImage()
  }

  private static func variableBlur(radius: Double, mask: CGImage?) -> NSObject? {
    guard let mask, let type = NSClassFromString("CAFilter") as? NSObject.Type else { return nil }
    let make = NSSelectorFromString("filterWithType:")
    guard type.responds(to: make), let filter = type.perform(make, with: "variableBlur")?.takeUnretainedValue() as? NSObject else { return nil }
    filter.setValue(radius, forKey: "inputRadius")
    filter.setValue(mask, forKey: "inputMaskImage")
    filter.setValue(true, forKey: "inputNormalizeEdges")
    return filter
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class EdgeFade: ExpoView {
  private let mask = CALayer()
  private let ramp = CAGradientLayer()
  private let solid = CALayer()
  var fadeHeight: Double = 24 { didSet { if fadeHeight != oldValue { placeMask() } } }
  var active = false { didSet { if active != oldValue { apply(animated: window != nil) } } }
  var duration: Double = 0.14

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    wantsLayer = true
    ramp.colors = [NSColor.clear.cgColor, NSColor.black.cgColor]
    solid.backgroundColor = NSColor.black.cgColor
    for layer in [ramp, solid] { layer.actions = ["bounds": NSNull(), "position": NSNull()] }
    mask.addSublayer(solid)
    mask.addSublayer(ramp)
    mask.actions = ["bounds": NSNull(), "position": NSNull()]
    (layer as? MaskKeepingLayer)?.kept = mask
    layer?.mask = mask
    apply(animated: false)
  }

  override func makeBackingLayer() -> CALayer { MaskKeepingLayer() }

  override func layout() {
    super.layout()
    placeMask()
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    placeMask()
  }

  private func placeMask() {
    guard let host = layer else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let flipped = host.isGeometryFlipped || isFlipped
    let fade = min(bounds.height, fadeHeight)
    mask.frame = bounds
    ramp.frame = CGRect(x: 0, y: flipped ? 0 : bounds.height - fade, width: bounds.width, height: fade)
    ramp.startPoint = CGPoint(x: 0.5, y: flipped ? 0 : 1)
    ramp.endPoint = CGPoint(x: 0.5, y: flipped ? 1 : 0)
    solid.frame = CGRect(x: 0, y: flipped ? fade : 0, width: bounds.width, height: max(0, bounds.height - fade))
    if host.mask !== mask { host.mask = mask }
    CATransaction.commit()
  }

  private func apply(animated: Bool) {
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    CATransaction.begin()
    CATransaction.setDisableActions(!animated || calm)
    CATransaction.setAnimationDuration(duration)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1))
    ramp.colors = [active ? NSColor.clear.cgColor : NSColor.black.cgColor, NSColor.black.cgColor]
    CATransaction.commit()
  }
}
