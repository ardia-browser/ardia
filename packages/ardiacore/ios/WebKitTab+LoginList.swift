import AppKit
import WebKit

extension WebKitTab: LoginListTarget {
  var loginListProfile: String { profile }
  var loginListPage: URL? { webView?.url }
  var loginListWindow: NSWindow? { isHiddenOrHasHiddenAncestor ? nil : window }
  var loginListEngine: String { "webkit" }

  func loginListFill(username: String, password: String, frameOrigin: String, done: @escaping (Bool) -> Void) {
    guard let webView, LoginList.origin(of: webView.url) == frameOrigin else { return done(false) }
    WebKitLoginFill.run(in: webView, frame: loginListFrame, world: WebKitHub.world, username: username, password: password, origin: frameOrigin, done: done)
  }

  func loginListFillCode(_ code: String, frameOrigin: String, done: @escaping (Bool) -> Void) {
    guard let webView, LoginList.origin(of: webView.url) == frameOrigin else { return done(false) }
    WebKitLoginFill.runCode(in: webView, frame: loginListFrame, world: WebKitHub.world, code: code, origin: frameOrigin, done: done)
  }

  func loginListFillNewPassword(_ password: String, frameOrigin: String, done: @escaping (Bool) -> Void) {
    guard let webView, LoginList.origin(of: webView.url) == frameOrigin else { return done(false) }
    WebKitLoginFill.runNewPassword(in: webView, frame: loginListFrame, world: WebKitHub.world, password: password, origin: frameOrigin, done: done)
  }

  func loginListConnect() { emit("applePasswordsConnect") }

  func loginListSync(open: Bool, picking: Bool) {
    webView?.evaluateJavaScript("window.__ardiaLogins && window.__ardiaLogins.dropdown(\(open), \(picking))", in: loginListFrame, in: WebKitHub.world) { _ in }
  }
}
