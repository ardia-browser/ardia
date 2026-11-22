import AppKit
import WebKit

@MainActor
final class WebKitExtensionAuthFlow: NSObject, WKNavigationDelegate, NSWindowDelegate {
  static let interactionRequired =
    "User interaction required. Try setting `abortOnLoadForNonInteractive` and `timeoutMsForNonInteractive` if multiple navigations are required, or if code is used for redirects in the authorization page after it's loaded."
  static let notApproved = "The user did not approve access."
  static let notLoaded = "Authorization page could not be loaded."
  static let defaultNonInteractiveTimeout: TimeInterval = 1

  let extensionId: String
  private let interactive: Bool
  private let abortOnLoad: Bool
  private let nonInteractiveTimeout: TimeInterval
  private let title: String
  private let view: WKWebView
  private var window: NSWindow?
  private var done: ((String?, String?) -> Void)?
  private var waiting: DispatchWorkItem?

  static func redirectHost(_ extensionId: String) -> String { "\(extensionId).chromiumapp.org" }

  static func loadable(_ url: URL?) -> Bool {
    guard let url, let scheme = url.scheme?.lowercased() else { return false }
    if scheme == "https" || scheme == "about" { return true }
    guard scheme == "http", let host = url.host?.lowercased() else { return false }
    return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
  }

  init(extensionId: String, title: String, options: [String: Any], dataStore: WKWebsiteDataStore) {
    self.extensionId = extensionId
    self.title = title
    interactive = options["interactive"] as? Bool ?? false
    abortOnLoad = options["abortOnLoadForNonInteractive"] as? Bool ?? true
    nonInteractiveTimeout = (options["timeoutMsForNonInteractive"] as? NSNumber).map { $0.doubleValue / 1000 } ?? Self.defaultNonInteractiveTimeout
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = dataStore
    view = WKWebView(frame: NSRect(x: 0, y: 0, width: 480, height: 640), configuration: configuration)
    super.init()
    view.navigationDelegate = self
  }

  func start(_ url: URL, done: @escaping (_ redirect: String?, _ error: String?) -> Void) {
    self.done = done
    guard Self.loadable(url) else { return finish(nil, Self.notLoaded) }
    if !interactive {
      let expire = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.finish(nil, Self.interactionRequired) } }
      waiting = expire
      DispatchQueue.main.asyncAfter(deadline: .now() + nonInteractiveTimeout, execute: expire)
    }
    view.load(URLRequest(url: url))
  }

  func cancel() { finish(nil, Self.notApproved) }

  private func finish(_ redirect: String?, _ error: String?) {
    guard let done else { return }
    self.done = nil
    waiting?.cancel()
    view.navigationDelegate = nil
    view.stopLoading()
    if let window {
      self.window = nil
      window.delegate = nil
      window.orderOut(nil)
    }
    done(redirect, error)
  }

  private func caught(_ url: URL?) -> Bool {
    guard let url, url.scheme == "https", url.host?.lowercased() == Self.redirectHost(extensionId) else { return false }
    finish(url.absoluteString, nil)
    return true
  }

  private func needsUser() {
    guard done != nil else { return }
    guard interactive else {
      if abortOnLoad { finish(nil, Self.interactionRequired) }
      return
    }
    show()
  }

  private func show() {
    guard window == nil else { return }
    let shown = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    shown.title = title
    shown.isReleasedWhenClosed = false
    shown.contentView = view
    shown.delegate = self
    window = shown
    if LaunchConfig.shared.background {
      NSLog("[webkit] web auth flow for %@ (background mode, not shown)", extensionId)
      return
    }
    shown.center()
    shown.makeKeyAndOrderFront(nil)
  }

  nonisolated func windowWillClose(_ notification: Notification) {
    MainActor.assumeIsolated { finish(nil, Self.notApproved) }
  }

  nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                           decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
    MainActor.assumeIsolated {
      guard navigationAction.targetFrame?.isMainFrame == true else { return decisionHandler(.allow) }
      let url = navigationAction.request.url
      if caught(url) { return decisionHandler(.cancel) }
      guard Self.loadable(url) else {
        decisionHandler(.cancel)
        return finish(nil, Self.notLoaded)
      }
      decisionHandler(.allow)
    }
  }

  nonisolated func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
    MainActor.assumeIsolated { _ = caught(webView.url) }
  }

  nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    MainActor.assumeIsolated {
      if !caught(webView.url) { needsUser() }
    }
  }

  nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
    MainActor.assumeIsolated {
      if (error as NSError).code == NSURLErrorCancelled || (error as NSError).code == 102 { return }
      if window == nil { finish(nil, Self.notLoaded) }
    }
  }

  nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
    MainActor.assumeIsolated {
      if (error as NSError).code == NSURLErrorCancelled { return }
      if window == nil { finish(nil, Self.notLoaded) }
    }
  }
}
