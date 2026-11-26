import AppKit
import Foundation
import Testing
import WebKit

private let world = WKContentWorld.world(name: "ardia")
private let origin = "https://bank.test"
private let username = "o'neil\"\\</script>\nuser"
private let password = "p'w\"d\\\\</script><script>alert(1)</script>\n\r\t\u{2028}\u{2029}${x}`é🔑"
private let fieldUsername = "o'neil\"\\</script>user"
private let fieldPassword = "p'w\"d\\\\</script><script>alert(1)</script>\t\u{2028}\u{2029}${x}`é🔑"

private let form = """
  <!doctype html><form><input id="u" name="user" autocomplete="username"><input id="p" type="password" name="pass" autocomplete="current-password"></form>
  <script>
  window.events = [];
  for (const el of document.querySelectorAll("input")) for (const kind of ["input", "change"]) el.addEventListener(kind, () => events.push(el.id + ":" + kind));
  </script>
  """

@MainActor private final class RecordingWebView: WKWebView, WKNavigationDelegate {
  var sources: [String] = []
  private var loaded: CheckedContinuation<Void, Never>?

  override func evaluateJavaScript(_ source: String, completionHandler: (@MainActor @Sendable (Any?, (any Error)?) -> Void)? = nil) {
    sources.append(source)
    super.evaluateJavaScript(source, completionHandler: completionHandler)
  }

  override func __evaluateJavaScript(
    _ source: String, inFrame frame: WKFrameInfo?, in contentWorld: WKContentWorld, completionHandler: (@MainActor @Sendable (Any?, (any Error)?) -> Void)? = nil
  ) {
    sources.append(source)
    super.__evaluateJavaScript(source, inFrame: frame, in: contentWorld, completionHandler: completionHandler)
  }

  override func __callAsyncJavaScript(
    _ source: String, arguments: [String: Any]?, inFrame frame: WKFrameInfo?, in contentWorld: WKContentWorld,
    completionHandler: (@MainActor @Sendable (Any?, (any Error)?) -> Void)? = nil
  ) {
    sources.append(source)
    super.__callAsyncJavaScript(source, arguments: arguments, inFrame: frame, in: contentWorld, completionHandler: completionHandler)
  }

  func load() async {
    navigationDelegate = self
    await withCheckedContinuation { loaded = $0; loadHTMLString(form, baseURL: URL(string: origin + "/login")) }
  }

  nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    MainActor.assumeIsolated {
      loaded?.resume()
      loaded = nil
    }
  }

  func read(_ expression: String) async -> Any? {
    await withCheckedContinuation { done in
      super.__evaluateJavaScript(expression, inFrame: nil, in: .page) { value, _ in done.resume(returning: value) }
    }
  }
}

@MainActor private func page() async -> RecordingWebView {
  let configuration = WKWebViewConfiguration()
  let script = ProcessInfo.processInfo.environment["ARDIA_LOGINS_SCRIPT"] ?? ""
  configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
  let view = RecordingWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: configuration)
  await view.load()
  return view
}

@MainActor private func fill(_ view: RecordingWebView, origin: String) async -> Bool {
  await withCheckedContinuation { done in
    WebKitLoginFill.run(in: view, world: world, username: username, password: password, origin: origin) { done.resume(returning: $0) }
  }
}

@MainActor @Suite struct WebKitLoginFillAsData {
  @Test func `the username and password land in the fields byte for byte, with input and change events`() async {
    let view = await page()
    #expect(await fill(view, origin: origin))
    let filledUsername = await view.read("document.getElementById('u').value") as? String
    let filledPassword = await view.read("document.getElementById('p').value") as? String
    let events = await view.read("events.join(',')") as? String
    #expect(filledUsername == fieldUsername)
    #expect(filledPassword == fieldPassword)
    #expect(events == "u:input,u:change,p:input,p:change")
  }

  @Test func `no script source handed to the page holds the username or the password`() async {
    let view = await page()
    view.sources = []
    _ = await fill(view, origin: origin)
    #expect(!view.sources.isEmpty)
    for source in view.sources {
      for secret in ["o'neil", "neil", "p'w", "alert(1)", "🔑"] { #expect(!source.contains(secret)) }
    }
  }

  @Test func `a fill for another origin leaves the fields empty`() async {
    let view = await page()
    #expect(await fill(view, origin: "https://evil.test") == false)
    #expect(await view.read("document.getElementById('p').value") as? String == "")
  }
}
