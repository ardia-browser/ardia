import AppKit
import ArdiaCore
import CryptoKit
import ExpoModulesCore
import WebKit

final class PluginPageMessageBridge: NSObject, WKScriptMessageHandler {
  static let live = NSHashTable<PluginPageMessageBridge>.weakObjects()

  let binding: PageBinding
  weak var webView: WKWebView?
  var delivered: ((String) -> Void)?
  private(set) var revoked = false
  private let limit = PluginPageMessages.Limit()

  init(_ binding: PageBinding) {
    self.binding = binding
    super.init()
    Self.live.add(self)
    if binding.run > 0 { PluginHost.shared.bindPage(binding) }
  }

  func revoke() {
    guard !revoked else { return }
    revoked = true
    PluginHost.shared.revokePage(binding)
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    let origin = message.frameInfo.securityOrigin
    guard !revoked, let webView, message.webView === webView, message.frameInfo.isMainFrame, origin.protocol == PluginSchemeHandler.scheme,
      origin.host == binding.plugin, binding.run > 0, limit.allow(now: ProcessInfo.processInfo.systemUptime)
    else { return }
    PluginHost.shared.pageMessage(binding, body: message.body)
    if let delivered, let text = message.body as? String, PluginPageMessages.fromPage(text, view: binding.view) != nil { delivered(text) }
  }

  static func deliver(_ binding: PageBinding, _ json: String, done: @escaping () -> Void) {
    guard let bridge = live.allObjects.first(where: { $0.binding == binding && !$0.revoked }), let webView = bridge.webView else { return done() }
    let script = "if (window.ardia) window.ardia.dispatchEvent(new MessageEvent(\"message\", { data: JSON.parse(\(PluginPageView.jsString(json))) }));"
    webView.evaluateJavaScript(script) { _, _ in done() }
  }
}

final class PluginPageView: ExpoView, WKNavigationDelegate, WKUIDelegate {
  static let live = WeakLookup<PluginPageView>()
  private var bridge: PluginPageMessageBridge?

  let onLoaded = EventDispatcher()
  let onTitleChange = EventDispatcher()
  let onNavigationChange = EventDispatcher()
  let onMessage = EventDispatcher()

  var plugin = "" { didSet { if plugin != oldValue { rebuild() } } }
  var url = "" { didSet { if url != oldValue { gate.wantsLoad() } } }
  var network = false { didSet { if network != oldValue { rebuild() } } }
  var folderId = "" { didSet { if folderId != oldValue { rebuild() } } }
  var approved = "" { didSet { if approved != oldValue { rebuild() } } }
  var run = 0 { didSet { if run != oldValue { rebuild() } } }
  var context = "" { didSet { if context != oldValue { handOver() } } }
  var themeCss = "" { didSet { if themeCss != oldValue { applyTheme() } } }

  static let themeWorld = WKContentWorld.world(name: "ardia-theme")
  private var observations: [NSKeyValueObservation] = []
  private var sentTitle: String?
  private var sentNavigation: [String: AnyHashable]?

  static let offlinePolicy =
    "default-src 'self' ardia-plugin: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ardia-plugin:; form-action 'self'; worker-src 'none'"

  private var web: WKWebView?
  private var allowedOrigin: (scheme: String, host: String, port: Int?)?

  private let watcher = WindowWatcher()
  private lazy var gate = PluginPageGate(
    bind: { [weak self] in self?.bindBridge() },
    unbind: { [weak self] in self?.bridge?.revoke() },
    load: { [weak self] in self?.loadNow() })

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    wantsLayer = true
    addSubview(watcher)
    watcher.changed = { [weak self] inWindow in self?.windowChanged(inWindow) }
  }

  private func windowChanged(_ inWindow: Bool) {
    gate.windowChanged(inWindow: inWindow)
  }

  private func bindBridge() {
    guard let web else { return }
    bridge?.revoke()
    let controller = web.configuration.userContentController
    controller.removeScriptMessageHandler(forName: "ardia", contentWorld: .page)
    let bridge = PluginPageMessageBridge(PageBinding.fresh(plugin: plugin, approved: approved, run: run))
    bridge.webView = web
    bridge.delivered = { [weak self] body in self?.onMessage(["body": body]) }
    controller.add(bridge, contentWorld: .page, name: "ardia")
    self.bridge = bridge
  }

  deinit {
    bridge?.revoke()
  }

  static func storeIdentifier(_ plugin: String) -> UUID {
    let scope = LaunchConfig.shared.dataDirectory ?? ""
    var bytes = Array(SHA256.hash(data: Data("ardia.plugin-page|\(scope)|\(plugin)".utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x50
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    return bytes.withUnsafeBufferPointer { NSUUID(uuidBytes: $0.baseAddress!) as UUID }
  }

  static func removeData(_ plugin: String, done: @escaping () -> Void) {
    PluginPageData.remove(storeIdentifier(plugin)) { _ in done() }
  }

  private func rebuild() {
    gate.pageRemoved()
    bridge = nil
    observations = []
    sentTitle = nil
    sentNavigation = nil
    web?.removeFromSuperview()
    web = nil
    guard PluginFolders.isName(plugin) else { return }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: Self.storeIdentifier(plugin))
    configuration.setURLSchemeHandler(
      PluginSchemeHandler(plugin: plugin, folderId: folderId, approved: approved, policy: network ? nil : Self.offlinePolicy), forURLScheme: PluginSchemeHandler.scheme)
    configuration.userContentController.addUserScript(pageScript())
    configuration.userContentController.addUserScript(themeScript())
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    if !network && !PluginPageOffline.hold(preferences: configuration.preferences, configuration: configuration) {
      NSLog("[plugins] %@'s page isn't shown: this macOS can't hold a page without network offline", plugin)
      return
    }
    configuration.mediaTypesRequiringUserActionForPlayback = .all
    let view = WKWebView(frame: bounds, configuration: configuration)
    if !network && !PluginPageOffline.isHeld(preferences: view.configuration.preferences, configuration: view.configuration) {
      NSLog("[plugins] %@'s page isn't shown: its web view didn't keep the offline settings", plugin)
      return
    }
    view.navigationDelegate = self
    view.uiDelegate = self
    view.autoresizingMask = [.width, .height]
    view.setValue(false, forKey: "drawsBackground")
    addSubview(view)
    web = view
    observe(view)
    Self.live[plugin] = self
    gate.pageCreated(inWindow: window != nil)
    gate.wantsLoad()
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    web?.frame = bounds
  }


  private static func origin(of url: URL) -> (scheme: String, host: String, port: Int?)? {
    guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
    return (scheme, host, url.port)
  }

  private func isAllowed(_ target: URL) -> Bool {
    guard let mine = allowedOrigin, let theirs = Self.origin(of: target) else { return false }
    return mine.scheme == theirs.scheme && mine.host == theirs.host && mine.port == theirs.port
  }

  static func jsString(_ text: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: text, options: [.fragmentsAllowed]), let literal = String(data: data, encoding: .utf8) else { return "\"\"" }
    return literal
  }

  private var contextLiteral: String { context.isEmpty ? "null" : "JSON.parse(\(Self.jsString(context)))" }

  private func pageScript() -> WKUserScript {
    let source = """
      (() => { const ardia = new EventTarget(); ardia.context = \(contextLiteral); \
      ardia.send = (message) => window.webkit.messageHandlers.ardia.postMessage(JSON.stringify(message)); \
      Object.defineProperty(window, "ardia", { value: ardia, writable: false, configurable: false }); })();
      """
    return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)
  }

  private var themeLiteral: String { Self.jsString(themeCss) }

  private func themeScript() -> WKUserScript {
    let source = """
      (() => { const apply = (text) => { let style = document.getElementById("ardia-theme"); \
      if (!style) { style = document.createElement("style"); style.id = "ardia-theme"; } style.textContent = text; \
      const root = document.head || document.documentElement; if (!root) return false; if (style.parentNode !== root) root.appendChild(style); return true; }; \
      window.__ardiaThemeCss = \(themeLiteral); window.__ardiaApplyTheme = apply; \
      if (!apply(window.__ardiaThemeCss)) { const watch = new MutationObserver(() => { if (apply(window.__ardiaThemeCss)) watch.disconnect(); }); \
      watch.observe(document, { childList: true, subtree: true }); } })();
      """
    return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: Self.themeWorld)
  }

  private func reinstallScripts(on web: WKWebView) {
    let controller = web.configuration.userContentController
    controller.removeAllUserScripts()
    controller.addUserScript(pageScript())
    controller.addUserScript(themeScript())
  }

  private func applyTheme() {
    guard let web else { return }
    reinstallScripts(on: web)
    let update = "window.__ardiaThemeCss = \(themeLiteral); if (window.__ardiaApplyTheme) window.__ardiaApplyTheme(window.__ardiaThemeCss); true;"
    web.evaluateJavaScript(update, in: nil, in: Self.themeWorld) { _ in }
  }

  private func observe(_ view: WKWebView) {
    observations = [
      view.observe(\.title, options: [.new]) { [weak self] _, _ in DispatchQueue.main.async { self?.reportTitle() } },
      view.observe(\.url, options: [.new]) { [weak self] _, _ in DispatchQueue.main.async { self?.reportNavigation() } },
      view.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in DispatchQueue.main.async { self?.reportNavigation() } },
      view.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in DispatchQueue.main.async { self?.reportNavigation() } },
    ]
  }

  private func reportTitle() {
    guard let web else { return }
    let title = web.title ?? ""
    guard title != sentTitle else { return }
    sentTitle = title
    onTitleChange(["title": title])
    reportNavigation()
  }

  private func reportNavigation() {
    guard let web, web.url != nil else { return }
    let state: [String: AnyHashable] = [
      "url": web.url?.absoluteString ?? "", "title": web.title ?? "", "canGoBack": web.canGoBack, "canGoForward": web.canGoForward,
    ]
    guard state != sentNavigation else { return }
    sentNavigation = state
    onNavigationChange(state)
  }

  private func handOver() {
    guard let web else { return }
    reinstallScripts(on: web)
    let update = "if (window.ardia) { window.ardia.context = \(contextLiteral); window.ardia.dispatchEvent(new Event(\"context\")); }"
    web.evaluateJavaScript(update, completionHandler: nil)
  }



  private func loadNow() {
    guard let web, let target = URL(string: url), let origin = Self.origin(of: target), origin.scheme == PluginSchemeHandler.scheme, origin.host == plugin else { return }
    allowedOrigin = origin
    web.load(URLRequest(url: target))
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let target = action.request.url, !action.shouldPerformDownload else { return decisionHandler(.cancel) }
    if isAllowed(target) && action.targetFrame != nil { return decisionHandler(.allow) }
    if target.scheme == "about" && action.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(response.canShowMIMEType ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    onLoaded(["url": webView.url?.absoluteString ?? "", "title": webView.title ?? ""])
    reportTitle()
    reportNavigation()
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    return nil
  }

  func webView(
    _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    decisionHandler(.deny)
  }

  func snapshot(to path: String, done: @escaping (Bool) -> Void) {
    guard let web else { return done(false) }
    web.takeSnapshot(with: nil) { image, _ in
      guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else {
        return done(false)
      }
      done((try? png.write(to: URL(fileURLWithPath: path))) != nil)
    }
  }
}
