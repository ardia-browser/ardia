import Foundation
import WebKit

enum WebKitAutofillFill {
  @MainActor
  static func run(
    in view: WKWebView, frame: WKFrameInfo?, world: WKContentWorld, token: String, kind: String, values: [String: Any], done: @escaping (Int) -> Void = { _ in }
  ) {
    guard let json = try? JSONSerialization.data(withJSONObject: values), let object = String(data: json, encoding: .utf8) else { return done(0) }
    let code = "window.__ardiaAutofill ? window.__ardiaAutofill.fill(\(quoted(token)), \(quoted(kind)), \(object)) : 0"
    view.evaluateJavaScript(code, in: frame, in: world) { result in
      if case .success(let value) = result { done((value as? NSNumber)?.intValue ?? 0) } else { done(0) }
    }
  }

  private static func quoted(_ text: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [text]), let json = String(data: data, encoding: .utf8) else { return "\"\"" }
    return String(json.dropFirst().dropLast())
  }
}
