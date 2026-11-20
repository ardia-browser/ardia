import WebKit

@available(macOS 15.4, *)
@MainActor
final class WebKitExtensionOffscreen: NSObject, WKNavigationDelegate {
  static let reasons: Set<String> = [
    "TESTING", "AUDIO_PLAYBACK", "IFRAME_SCRIPTING", "DOM_SCRAPING", "BLOBS", "DOM_PARSER", "USER_MEDIA", "DISPLAY_MEDIA", "WEB_RTC", "CLIPBOARD",
    "LOCAL_STORAGE", "WORKERS", "BATTERY_STATUS", "MATCH_MEDIA", "GEOLOCATION",
  ]
  static let loadDeadline: TimeInterval = 15

  private struct Document {
    let view: WKWebView
    let url: URL
    var ready: [(String?) -> Void]
  }

  private var documents: [String: Document] = [:]

  func has(_ extensionId: String) -> Bool { documents[extensionId] != nil }

  func create(_ options: [String: Any], context: WKWebExtensionContext, extensionId: String, done: @escaping (String?) -> Void) {
    guard documents[extensionId] == nil else { return done("Only a single offscreen document may be created.") }
    guard let path = options["url"] as? String, let url = URL(string: path, relativeTo: context.baseURL)?.absoluteURL,
      url.scheme == context.baseURL.scheme, url.host == context.baseURL.host
    else { return done("Invalid URL.") }
    let reasons = (options["reasons"] as? [Any] ?? []).compactMap { $0 as? String }
    guard !reasons.isEmpty, reasons.allSatisfy(Self.reasons.contains) else { return done("A reason must be provided.") }
    guard let justification = options["justification"] as? String, !justification.isEmpty else { return done("A justification must be provided.") }
    guard let configuration = context.webViewConfiguration else { return done("The extension isn't loaded.") }
    let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
    view.navigationDelegate = self
    documents[extensionId] = Document(view: view, url: url, ready: [done])
    view.load(URLRequest(url: url))
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.loadDeadline) { [weak self, weak view] in
      MainActor.assumeIsolated {
        guard let self, let view else { return }
        self.finish(view, nil)
      }
    }
  }

  func close(_ extensionId: String) -> String? {
    guard let document = documents.removeValue(forKey: extensionId) else { return "No current offscreen document." }
    tearDown(document)
    return nil
  }

  func closeAll(of extensionId: String? = nil) {
    for (id, document) in documents where extensionId == nil || id == extensionId {
      documents.removeValue(forKey: id)
      tearDown(document)
    }
  }

  private func tearDown(_ document: Document) {
    document.ready.forEach { $0(nil) }
    document.view.navigationDelegate = nil
    document.view.stopLoading()
    document.view.loadHTMLString("", baseURL: nil)
  }

  private func finish(_ view: WKWebView, _ error: String?) {
    guard let (id, document) = documents.first(where: { $0.value.view === view }) else { return }
    let waiting = document.ready
    documents[id]?.ready = []
    if error != nil { documents.removeValue(forKey: id) }
    waiting.forEach { $0(error) }
  }

  nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    MainActor.assumeIsolated { finish(webView, nil) }
  }

  nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
    MainActor.assumeIsolated { finish(webView, "Page failed to load.") }
  }

  nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
    MainActor.assumeIsolated { finish(webView, "Page failed to load.") }
  }
}
