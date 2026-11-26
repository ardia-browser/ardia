import Foundation
import WebKit

enum WebKitAutofillFill {
  private static let body = "return window.__ardiaAutofill ? window.__ardiaAutofill.fill(token, kind, values) : 0"

  @MainActor
  static func run(
    in view: WKWebView, frame: WKFrameInfo?, world: WKContentWorld, token: String, kind: String, values: [String: Any], done: @escaping (Int) -> Void = { _ in }
  ) {
    let arguments: [String: Any] = ["token": token, "kind": kind, "values": values]
    view.callAsyncJavaScript(body, arguments: arguments, in: frame, in: world) { result in
      if case .success(let value) = result { done((value as? NSNumber)?.intValue ?? 0) } else { done(0) }
    }
  }
}
