import AppKit
import WebKit

extension WebKitTab: LoginListTarget {
  var loginListProfile: String { profile }
  var loginListPage: URL? { webView?.url }
  var loginListWindow: NSWindow? { isHiddenOrHasHiddenAncestor ? nil : window }

  func loginListFill(username: String, password: String, frameOrigin: String, done: @escaping (Bool) -> Void) {
    guard let webView, LoginList.origin(of: webView.url) == frameOrigin else { return done(false) }
    WebKitLoginFill.run(in: webView, world: WebKitHub.world, username: username, password: password, origin: frameOrigin, done: done)
  }

  func loginListSync(open: Bool, picking: Bool) {
    webView?.evaluateJavaScript("window.__ardiaLogins && window.__ardiaLogins.dropdown(\(open), \(picking))", in: nil, in: WebKitHub.world) { _ in }
  }
}
