import Foundation
import WebKit

enum WebKitLoginFill {
  private static let body = "return window.__ardiaLogins ? window.__ardiaLogins.fill(username, password, origin) : false"

  @MainActor
  static func run(in view: WKWebView, world: WKContentWorld, username: String, password: String, origin: String, done: @escaping (Bool) -> Void = { _ in }) {
    let arguments = ["username": username, "password": password, "origin": origin]
    view.callAsyncJavaScript(body, arguments: arguments, in: nil, in: world) { result in
      if case .success(let value) = result { done(value as? Bool ?? false) } else { done(false) }
    }
  }
}
