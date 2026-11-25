import AppKit

extension PeekStage {
  private var mapsInput: Bool {
    let f = lastFrame
    guard !motion.geometry.fullscreen, !f.warping, motion.phase != .waiting, motion.phase != .idle else { return false }
    return abs(f.page.s - 1) > 1e-6 || abs(f.page.tx) > 1e-6 || abs(f.page.ty) > 1e-6
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard !isHidden, alphaValue > 0, let parent = superview else { return nil }
    let p = convert(point, from: parent)
    guard bounds.contains(p) else { return nil }
    if motion.phase == .finished { return nil }
    if lastFrame.warping || motion.warpingEntrance {
      return shownCard.contains(p) ? self : scrim.hitTest(p)
    }
    if motion.phase == .waiting { return shownCard.contains(p) ? self : scrim.hitTest(p) }
    if PeekInputRoute.matches(self, windowPoint: convert(p, to: nil)) { return page.hitTest(lastFrame.page.apply(p)) ?? self }
    if !mapsInput { return super.hitTest(point) }
    if lastFrame.shownPage.contains(p) { return page.hitTest(p) ?? self }
    if shownCard.contains(p) { return chrome.hitTest(lastFrame.card.inverse.apply(p)) ?? self }
    return scrim.hitTest(p)
  }

  func remap(_ event: NSEvent, at windowPoint: NSPoint) -> NSEvent? {
    let p = convert(windowPoint, from: nil)
    let through = settlesEntrance(event, at: p)
    guard let window, mapsInput else { return nil }
    let shown = through.map { _ in true } ?? lastFrame.shownPage.contains(p)
    var mapping = through ?? lastFrame.page
    switch event.type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
      pressInPage = shown && owns(windowPoint, in: window)
      pressMapping = pressInPage ? through : nil
      guard pressInPage else { return nil }
    case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .leftMouseUp, .rightMouseUp, .otherMouseUp:
      guard pressInPage else { return nil }
      mapping = pressMapping ?? mapping
      if event.type == .leftMouseUp || event.type == .rightMouseUp || event.type == .otherMouseUp {
        pressInPage = false
        pressMapping = nil
      }
    default:
      guard shown, owns(windowPoint, in: window) else { return nil }
    }
    let target = convert(mapping.inverse.apply(p), to: nil)
    guard let mapped = PeekInputRoute.moved(event, to: target, in: window) else { return nil }
    PeekInputRoute.routed = PeekInputRoute.Routed(stage: self, point: target, timestamp: event.timestamp)
    return mapped
  }

  private func settlesEntrance(_ event: NSEvent, at p: NSPoint) -> PeekAffine? {
    guard [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel].contains(event.type), !isHiddenOrHasHiddenAncestor, gestures,
          motion.phase == .waiting || motion.phase == .entering, !motion.geometry.fullscreen else { return nil }
    let visible = lastFrame
    let blocked = motion.phase == .waiting || visible.warping || motion.warpingEntrance
    guard blocked ? motion.geometry.rest.contains(p) : visible.shownPage.contains(p) else { return nil }
    settleEntrance()
    return blocked ? nil : visible.page
  }

  private func owns(_ windowPoint: NSPoint, in window: NSWindow) -> Bool {
    guard let root = window.contentView?.superview, let hit = root.hitTest(windowPoint) else { return false }
    return hit === self || hit.isDescendant(of: self)
  }
}
