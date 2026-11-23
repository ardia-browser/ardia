import AppKit
import ArdiaCore
import ExpoModulesCore

final class SvgIconView: ExpoView {
  private let art = CALayer()
  var svg = "" { didSet { if svg != oldValue { redraw() } } }
  var tint: NSColor? { didSet { redraw() } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    wantsLayer = true
    art.actions = ["bounds": NSNull(), "position": NSNull(), "contents": NSNull(), "contentsScale": NSNull()]
    art.contentsGravity = .resize
    NotificationCenter.default.addObserver(self, selector: #selector(interfaceScaleDidChange), name: .ArdiaInterfaceScaleDidChange, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(interfaceScaleDidChange), name: .ArdiaInterfaceScaleDidSettle, object: nil)
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
    redraw()
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    redraw()
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    redraw()
  }

  private func redraw() {
    guard let layer else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    if art.superlayer !== layer { layer.addSublayer(art) }
    art.frame = bounds
    guard bounds.width > 0, bounds.height > 0, !svg.isEmpty else {
      art.contents = nil
      return
    }
    let scale = max(1, backingDensity)
    var rendered: CGImage?
    effectiveAppearance.performAsCurrentDrawingAppearance {
      rendered = SvgArt.image(svg: svg, size: bounds.size, scale: scale, tint: tint ?? .labelColor)
    }
    art.contentsScale = scale
    art.contents = rendered
  }
}
