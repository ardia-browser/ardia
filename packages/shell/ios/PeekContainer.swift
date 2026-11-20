import AppKit

final class PeekContainer: NSView {
  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layerContentsRedrawPolicy = .never
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isFlipped: Bool { true }

  func hold(_ child: NSView?) {
    let wanted = child.map { [$0] } ?? []
    if subviews != wanted { subviews = wanted }
  }

  var topDown: Bool {
    guard let child = subviews.first, let layer = child.layer else { return true }
    let height = bounds.height
    let asView = abs(layer.frame.minY - child.frame.minY)
    let asFlipped = abs(layer.frame.minY - (height - child.frame.maxY))
    return asView <= asFlipped
  }
}
