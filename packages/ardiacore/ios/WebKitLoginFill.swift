import Foundation
import WebKit

enum WebKitLoginFill {
  @MainActor
  static func run(in view: WKWebView, world: WKContentWorld, username: String, password: String, origin: String, done: @escaping (Bool) -> Void = { _ in }) {
    let code = "window.__ardiaLogins ? window.__ardiaLogins.fill(\(quoted(username)), \(quoted(password)), \(quoted(origin))) : false"
    view.evaluateJavaScript(code, in: nil, in: world) { result in
      if case .success(let value) = result { done(value as? Bool ?? false) } else { done(false) }
    }
  }

  private static func quoted(_ text: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [text]), let json = String(data: data, encoding: .utf8) else { return "\"\"" }
    return String(json.dropFirst().dropLast())
  }
}
