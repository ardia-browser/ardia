import AppKit

extension ArdiaWebView: LoginListTarget {
  var loginListProfile: String { profile }
  var loginListPage: URL? { loginListPageURL }
  var loginListWindow: NSWindow? { visible && !isHiddenOrHasHiddenAncestor ? window : nil }

  func loginListFill(username: String, password: String, frameOrigin: String, done: @escaping (Bool) -> Void) {
    done(false)
  }

  func loginListSync(open: Bool, picking: Bool) { syncLoginList(open: open, picking: picking) }

  func loginListConnect() { connectApplePasswordsFromLoginList() }

  @objc(showLoginListFrom:screenRect:typing:typed:)
  func showLoginList(from origin: String, screenRect: NSRect, typing: Bool, typed: String) {
    LoginList.shared.show(self, field: LoginListField(frameOrigin: origin, screenRect: screenRect, trigger: typing ? .typing : .press, typed: typed))
  }

  @objc(keyLoginList:)
  func keyLoginList(_ key: String) { LoginList.shared.key(self, key) }

  @objc func closeLoginList() { LoginList.shared.close(self) }
}
