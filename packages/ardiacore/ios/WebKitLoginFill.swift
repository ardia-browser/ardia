import Foundation
import WebKit

enum WebKitLoginFill {
  private static let body = "return window.__ardiaLogins ? window.__ardiaLogins.fill(username, password, origin) : false"
  private static let newPasswordBody = "return window.__ardiaLogins ? window.__ardiaLogins.fillNewPassword(password, origin) : false"
  private static let codeBody = "return window.__ardiaLogins ? window.__ardiaLogins.fillCode(code, origin) : false"

  @MainActor
  static func run(in view: WKWebView, world: WKContentWorld, username: String, password: String, origin: String, done: @escaping (Bool) -> Void = { _ in }) {
    let arguments = ["username": username, "password": password, "origin": origin]
    view.callAsyncJavaScript(body, arguments: arguments, in: nil, in: world) { result in
      if case .success(let value) = result { done(value as? Bool ?? false) } else { done(false) }
    }
  }

  @MainActor
  static func runCode(in view: WKWebView, world: WKContentWorld, code: String, origin: String, done: @escaping (Bool) -> Void) {
    view.callAsyncJavaScript(codeBody, arguments: ["code": code, "origin": origin], in: nil, in: world) { result in
      if case .success(let value) = result { done(value as? Bool ?? false) } else { done(false) }
    }
  }

  @MainActor
  static func runNewPassword(in view: WKWebView, world: WKContentWorld, password: String, origin: String, done: @escaping (Bool) -> Void) {
    view.callAsyncJavaScript(newPasswordBody, arguments: ["password": password, "origin": origin], in: nil, in: world) { result in
      if case .success(let value) = result { done(value as? Bool ?? false) } else { done(false) }
    }
  }
}
