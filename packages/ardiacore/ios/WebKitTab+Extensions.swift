import AppKit
import WebKit

extension WebKitTab {
  func noteExtensionTabOpened() { WebKitExtensions.shared.tabOpened(self) }

  func noteExtensionTabClosed() {
    WebKitExtensions.shared.tabClosed(self)
    WebKitHub.shared.logins.forget(self)
    WebKitAutofill.shared.forget(self)
  }

  func noteExtensionTabShown() { WebKitExtensions.shared.tabShown(self) }

  func noteExtensionTabChanged() { WebKitExtensions.shared.tabChanged(self) }

  func runExtensionAction(_ extensionId: String) -> String? { WebKitExtensions.shared.performAction(extensionId, tab: self) }

  func setExtensionZoom(_ factor: Double) {
    guard let view = webView else { return }
    let zoom = factor > 0 && factor.isFinite ? min(max(factor, Self.zoomLevels[0]), Self.zoomLevels[Self.zoomLevels.count - 1]) : 1
    view.pageZoom = zoom
    if let host = view.url?.host?.lowercased(), !host.isEmpty { WebKitHub.shared.stores.setZoom(zoom, profile: profile, host: host) }
    emit("zoom", ["zoom": zoom, "host": view.url?.host?.lowercased() ?? "", "isDefault": abs(zoom - 1) < 0.001, "pinchScale": view.magnification, "user": false])
  }
}

@available(macOS 15.4, *)
extension WebKitTab: WKWebExtensionTab {
  private func hub(_ context: WKWebExtensionContext) -> WebKitExtensionHub? { context.webExtensionController?.delegate as? WebKitExtensionHub }

  func window(for context: WKWebExtensionContext) -> (any WKWebExtensionWindow)? { hub(context)?.window(of: self) }

  func indexInWindow(for context: WKWebExtensionContext) -> Int {
    guard let hub = hub(context), let host = hub.host(of: self) else { return NSNotFound }
    return hub.tabs(in: host).firstIndex { $0 === self } ?? NSNotFound
  }

  func parentTab(for context: WKWebExtensionContext) -> (any WKWebExtensionTab)? { hub(context)?.opener(of: self) }

  func setParentTab(_ parentTab: (any WKWebExtensionTab)?, for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    guard let hub = hub(context) else { return completionHandler(nil) }
    hub.setOpener(self, parentTab as? WebKitTab, completion: completionHandler)
  }

  func isPinned(for context: WKWebExtensionContext) -> Bool { hub(context)?.isPinned(self) ?? false }

  func setPinned(_ pinned: Bool, for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    guard let hub = hub(context) else { return completionHandler(nil) }
    hub.setPinned(self, pinned, completion: completionHandler)
  }

  func activate(for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    guard let hub = hub(context) else { return completionHandler(nil) }
    hub.activate(self, completion: completionHandler)
  }

  func close(for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    guard let hub = hub(context) else { return completionHandler(nil) }
    hub.close(self, completion: completionHandler)
  }

  func duplicate(using configuration: WKWebExtension.TabConfiguration, for context: WKWebExtensionContext,
                 completionHandler: @escaping ((any WKWebExtensionTab)?, (any Error)?) -> Void) {
    guard let hub = hub(context) else { return completionHandler(nil, nil) }
    hub.duplicate(self, active: configuration.shouldBeActive, completion: completionHandler)
  }

  func setZoomFactor(_ zoomFactor: Double, for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    if let hub = hub(context) { hub.setZoom(self, zoomFactor) } else { setExtensionZoom(zoomFactor) }
    completionHandler(nil)
  }

  func webView(for context: WKWebExtensionContext) -> WKWebView? { webView }

  func title(for context: WKWebExtensionContext) -> String? { webView?.title }

  func url(for context: WKWebExtensionContext) -> URL? { webView?.url }

  func isLoadingComplete(for context: WKWebExtensionContext) -> Bool { webView?.isLoading == false }

  func isPlayingAudio(for context: WKWebExtensionContext) -> Bool { audible }

  func isMuted(for context: WKWebExtensionContext) -> Bool { effectiveMuted }

  func zoomFactor(for context: WKWebExtensionContext) -> Double { Double(webView?.pageZoom ?? 1) }

  func size(for context: WKWebExtensionContext) -> CGSize { bounds.size }

  func isSelected(for context: WKWebExtensionContext) -> Bool { hub(context)?.isActive(self) ?? visible }

  func loadURL(_ url: URL, for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    guard WebKitExtensionAccess.mayNavigate(to: url) else { return completionHandler(WebKitExtensionBridge.failure("Extensions can’t open this URL.")) }
    loadURL(url.absoluteString, userInitiated: false)
    completionHandler(nil)
  }

  func reload(fromOrigin: Bool, for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    if fromOrigin { reloadIgnoringCache() } else { reload() }
    completionHandler(nil)
  }

  func goBack(for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    goBack()
    completionHandler(nil)
  }

  func goForward(for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    goForward()
    completionHandler(nil)
  }

  func setMuted(_ muted: Bool, for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    setMuted(muted)
    completionHandler(nil)
  }

  func shouldGrantPermissionsOnUserGesture(for context: WKWebExtensionContext) -> Bool { true }
}
