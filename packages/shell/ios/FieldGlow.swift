import AppKit
import ExpoModulesCore

final class FieldGlow: ExpoView, FieldGlowTarget {
  static let hub = FieldGlowHub()

  private let layers = FieldGlowLayers()

  var glowId: String? {
    didSet {
      guard glowId != oldValue else { return }
      if let oldValue {
        Self.hub.detach(oldValue, self)
        layers.cancel()
      }
      if let glowId { Self.hub.attach(glowId, self) }
    }
  }
  var radius: Double {
    get { layers.radius }
    set { layers.radius = newValue }
  }
  var look: FieldGlowLook {
    get { layers.look }
    set { layers.look = newValue }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    wantsLayer = true
    layers.animates = { [weak self] in self?.window != nil }
    layers.finishingGeneration = { [weak self] in
      guard let id = self?.glowId, let model = Self.hub.model(id), model.phase == .finishing else { return nil }
      return model.generation
    }
    layers.onFinished = { [weak self] generation in
      guard let id = self?.glowId else { return }
      Self.hub.finished(id, generation: generation)
    }
  }

  deinit {
    if let glowId { Self.hub.detach(glowId, self) }
    layers.cancel()
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func layout() {
    super.layout()
    layoutGlow()
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    layoutGlow()
  }

  private func layoutGlow() {
    guard let layer else { return }
    if layers.clip.superlayer !== layer {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      layer.addSublayer(layers.clip)
      CATransaction.commit()
    }
    layers.resize(bounds.size, flipped: layer.isGeometryFlipped || isFlipped)
  }

  func settle(at model: FieldGlowModel) { layers.settle(at: model) }

  func run(_ moves: [FieldGlowMove], model: FieldGlowModel) { layers.run(moves, model: model) }
}
