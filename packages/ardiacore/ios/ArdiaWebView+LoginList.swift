import AppKit

extension ArdiaWebView: LoginListTarget {
  var loginListProfile: String { profile }
  var loginListPage: URL? { loginListPageURL }
  var loginListWindow: NSWindow? { visible && !isHiddenOrHasHiddenAncestor ? window : nil }
  var loginListEngine: String { "chromium" }

  func loginListFill(username: String, password: String, frameOrigin: String, done: @escaping (Bool) -> Void) {
    fillLoginList(["username": username, "password": password], origin: frameOrigin, completion: done)
  }

  func loginListFillCode(_ code: String, frameOrigin: String, done: @escaping (Bool) -> Void) {
    fillLoginList(["code": code], origin: frameOrigin, completion: done)
  }

  func loginListSync(open: Bool, picking: Bool) { syncLoginList(open: open, picking: picking) }

  func loginListConnect() { connectApplePasswordsFromLoginList() }

  @objc(showLoginListFrom:screenRect:typing:typed:code:)
  func showLoginList(from origin: String, screenRect: NSRect, typing: Bool, typed: String, code: Bool) {
    LoginList.shared.show(self, field: LoginListField(frameOrigin: origin, screenRect: screenRect, trigger: typing ? .typing : .press, typed: typed, kind: code ? .code : .login))
  }

  @objc(keyLoginList:)
  func keyLoginList(_ key: String) { LoginList.shared.key(self, key) }

  @objc func closeLoginList() { LoginList.shared.close(self) }

  @objc var loginListShown: Bool { LoginList.shared.isShown(for: self) }
}
