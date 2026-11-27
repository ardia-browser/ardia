import AppKit
import WebKit

extension WebKitTab {
  private static let reclaimSettledAfter: Double = 1

  private func inFullscreen(_ view: WKWebView) -> Bool { view.fullscreenState != .notInFullscreen }

  override func didAddSubview(_ subview: NSView) {
    super.didAddSubview(subview)
    if subview === webView { updateHidden() }
  }

  override func viewWillMove(toWindow newWindow: NSWindow?) {
    placeholdersWillLeave(window)
    super.viewWillMove(toWindow: newWindow)
  }

  var pageHeldInFullscreen: Bool {
    guard let view = webView else { return false }
    return WebKitFullscreenPage.heldElsewhere(view, from: self, inFullscreen: inFullscreen(view))
  }

  func letGo(_ view: WebKitWebView) {
    guard WebKitFullscreenPage.heldElsewhere(view, from: self, inFullscreen: inFullscreen(view)) else { return view.removeFromSuperview() }
    view.fullscreenPlaceholders = WebKitFullscreenPage.takePlaceholders(from: self)
    countFullscreenPage("fullscreenMovedWithTab", stamp: ArdiaConsentStamp.begin())
  }

  func place(_ view: WebKitWebView) {
    let placeholders = view.fullscreenPlaceholders
    view.fullscreenPlaceholders = []
    guard WebKitFullscreenPage.heldElsewhere(view, from: self, inFullscreen: inFullscreen(view)) else {
      view.frame = bounds
      addSubview(view)
      return
    }
    WebKitFullscreenPage.give(placeholders, to: self)
  }

  var fullscreenWindowSeen: Bool {
    guard let window = webView?.window else { return false }
    return window.occlusionState.contains(.visible)
  }

  func publishAdoptedFullscreen() {
    guard let view = webView else { return }
    let on = WebKitFullscreenPage.isOn(view.fullscreenState)
    pageMedia.fullscreen = on
    watchFullscreenSight(on)
    emit("fullscreen", ["fullscreen": on])
  }

  func watchFullscreenSight(_ on: Bool) {
    if let token = life.fullscreenSight { NotificationCenter.default.removeObserver(token) }
    life.fullscreenSight = nil
    guard on, !closed else { return }
    life.fullscreenSight = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: nil, queue: .main) { [weak self] note in
      guard let self, let shown = self.webView?.window, (note.object as? NSWindow) === shown, self.pageHeldInFullscreen else { return }
      self.updateSight()
    }
  }

  func placeholdersWillLeave(_ window: NSWindow?) {
    WebKitFullscreenPage.unregister(WebKitFullscreenPage.placeholders(in: self), from: window)
  }

  func placeholdersDidArrive(in window: NSWindow?) {
    WebKitFullscreenPage.register(WebKitFullscreenPage.placeholders(in: self), with: window)
  }

  func fullscreenPageMoved(_ state: WKWebView.FullscreenState) {
    let exit = life.fullscreenExits.changed()
    if state == .enteringFullscreen { life.fullscreenKeptShownCounted = false }
    watchFullscreenSight(WebKitFullscreenPage.isOn(state))
    updateHidden()
    updateSight()
    guard state == .notInFullscreen else { return }
    let ticket = WebKitFullscreenReclaim(generation: exit, epoch: ArdiaEvents.consentEpoch, page: webView)
    DispatchQueue.main.async { [weak self] in self?.reclaimPage(ticket, settled: false) }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.reclaimSettledAfter) { [weak self] in self?.reclaimPage(ticket, settled: true) }
  }

  func noteFullscreenPageKeptShown() {
    guard !visible, !life.fullscreenKeptShownCounted, pageHeldInFullscreen else { return }
    life.fullscreenKeptShownCounted = true
    countFullscreenPage("fullscreenKeptShown", stamp: ArdiaConsentStamp.begin())
  }

  private func reclaimPage(_ ticket: WebKitFullscreenReclaim, settled: Bool) {
    guard !closed, let view = webView, ticket.belongs(to: life.fullscreenExits.generation, page: view),
          WebKitFullscreenPage.reclaims(view, into: self, inFullscreen: inFullscreen(view), settled: settled) else { return }
    view.removeFromSuperview()
    view.frame = bounds
    view.autoresizingMask = [.width, .height]
    addSubview(view)
    guard ticket.counts(under: ArdiaEvents.consentEpoch) else { return }
    countFullscreenPage("fullscreenPageReclaimed", stamp: ArdiaConsentStamp(epoch: ticket.epoch))
  }

  private func countFullscreenPage(_ name: String, stamp: ArdiaConsentStamp) {
    ArdiaEvents.emit("webKit.counted", data: stamp.onto(["name": name]))
  }
}
