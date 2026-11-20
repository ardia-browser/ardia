import AppKit
import ArdiaCore
import Carbon.HIToolbox
import ExpoModulesCore

public class FadeLabelModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaFadeLabel")

    View(FadeLabel.self) {
      Prop("text") { (view: FadeLabel, v: String) in view.text = v }
      Prop("fontSize") { (view: FadeLabel, v: Double) in view.fontSize = v }
      Prop("weight") { (view: FadeLabel, v: String) in view.weight = v }
      Prop("fontFamily") { (view: FadeLabel, v: String) in view.fontFamily = v }
      Prop("color") { (view: FadeLabel, hex: String) in view.color = RGBA(hex: hex)?.srgb ?? .labelColor }
      Prop("fadeWidth") { (view: FadeLabel, v: Double) in view.fadeWidth = v }
      Prop("strikethrough") { (view: FadeLabel, v: Bool) in view.strikethrough = v }
    }
  }
}

public class EdgeFadeMaskModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaEdgeFadeMask")

    View(EdgeFadeMask.self) {
      Prop("fadeWidth") { (view: EdgeFadeMask, v: Double) in view.fadeWidth = v }
      Prop("floor") { (view: EdgeFadeMask, v: Double) in view.floor = v }
      Prop("onset") { (view: EdgeFadeMask, v: Double) in view.onset = v }
    }
  }
}

final class MaskKeepingLayer: CALayer {
  var kept: CALayer?

  override init() { super.init() }
  override init(layer: Any) { super.init(layer: layer) }
  required init?(coder: NSCoder) { super.init(coder: coder) }

  override var mask: CALayer? {
    get { super.mask }
    set { super.mask = newValue ?? kept }
  }
}

final class EdgeFadeMask: ExpoView {
  var fadeWidth: Double = 88 { didSet { applyMask(force: true) } }
  var floor: Double = 0.25 { didSet { applyMask(force: true) } }
  var onset: Double = 24 { didSet { applyMask(force: true) } }

  private let fade = CAGradientLayer()
  private weak var watched: NSScrollView?
  private weak var watchedDocument: NSView?
  private var shown: (left: CGFloat, right: CGFloat, bounds: CGRect)?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    wantsLayer = true
    fade.startPoint = CGPoint(x: 0, y: 0.5)
    fade.endPoint = CGPoint(x: 1, y: 0.5)
  }

  override func didAddSubview(_ subview: NSView) {
    super.didAddSubview(subview)
    watch()
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    watch()
  }

  override func layout() {
    super.layout()
    watch()
    applyMask()
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    applyMask()
  }

  override func makeBackingLayer() -> CALayer { MaskKeepingLayer() }

  private func watch() {
    if let scroll = watched, scroll.isDescendant(of: self), scroll.documentView === watchedDocument { return }
    let center = NotificationCenter.default
    if let scroll = watched {
      center.removeObserver(self, name: NSView.boundsDidChangeNotification, object: scroll.contentView)
      center.removeObserver(self, name: NSView.frameDidChangeNotification, object: scroll.contentView)
    }
    if let document = watchedDocument { center.removeObserver(self, name: NSView.frameDidChangeNotification, object: document) }
    watched = Self.firstScrollView(in: self)
    watchedDocument = watched?.documentView
    guard let scroll = watched else { return }
    let clip = scroll.contentView
    clip.postsBoundsChangedNotifications = true
    clip.postsFrameChangedNotifications = true
    center.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: clip)
    center.addObserver(self, selector: #selector(scrolled), name: NSView.frameDidChangeNotification, object: clip)
    if let document = watchedDocument {
      document.postsFrameChangedNotifications = true
      center.addObserver(self, selector: #selector(scrolled), name: NSView.frameDidChangeNotification, object: document)
    }
    applyMask(force: true)
  }

  private static func firstScrollView(in root: NSView) -> NSScrollView? {
    var queue = root.subviews
    while !queue.isEmpty {
      let view = queue.removeFirst()
      if let scroll = view as? NSScrollView { return scroll }
      queue.append(contentsOf: view.subviews)
    }
    return nil
  }

  @objc private func scrolled() {
    if watched?.documentView !== watchedDocument { watch() }
    applyMask()
  }

  private func applyMask(force: Bool = false) {
    guard let layer else { return }
    var left: CGFloat = 0
    var right: CGFloat = 0
    if let scroll = watched, let document = scroll.documentView, onset > 0 {
      let offset = scroll.contentView.bounds.origin.x
      let last = max(0, document.frame.width - scroll.contentView.bounds.width)
      left = max(0, min(1, offset / onset))
      right = max(0, min(1, (last - offset) / onset))
    }
    let width = bounds.width
    let fading = (left > 0 || right > 0) && width > 0
    if !force, let shown, shown.left == left, shown.right == right, shown.bounds == bounds, (layer.mask === fade) == fading { return }
    shown = (left, right, bounds)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if fading {
      let edge = min(0.5, fadeWidth / width)
      fade.frame = bounds
      fade.locations = [0, NSNumber(value: edge), NSNumber(value: 1 - edge), 1]
      fade.colors = [1 - (1 - floor) * left, 1, 1, 1 - (1 - floor) * right].map { NSColor.black.withAlphaComponent($0).cgColor }
      (layer as? MaskKeepingLayer)?.kept = fade
      if layer.mask !== fade { layer.mask = fade }
    } else {
      (layer as? MaskKeepingLayer)?.kept = nil
      if layer.mask === fade { layer.mask = nil }
    }
    CATransaction.commit()
  }
}
