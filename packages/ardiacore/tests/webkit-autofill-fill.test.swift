import AppKit
import Foundation
import Testing
import WebKit

private let world = WKContentWorld.world(name: "ardia")
private let origin = "https://shop.test"
private let cardName = "O'Neil \"Q\" \\ </script><script>alert(1)</script> ${x}`é💳"
private let cardNumber = "4111111111111111"
private let addressName = "Zoë d'Arc \"the\" \\\\ </script>"
private let organization = "Acme \"&\" Co's </script><script>alert(2)</script>"
private let street = "1 O'Hare \"Way\" \\ </script>\nApt `2` ${y}"
private let city = "Saint-Jean's \"\\\" </script>"

private let cardForm = """
  <!doctype html><style>input { position: absolute; left: 10px; width: 200px; height: 20px; }</style>
  <form><input id="name" autocomplete="cc-name" style="top: 10px"><input id="number" autocomplete="cc-number" style="top: 40px">
  <input id="month" autocomplete="cc-exp-month" style="top: 70px"><input id="year" autocomplete="cc-exp-year" style="top: 100px"></form>
  <script>
  window.events = [];
  for (const el of document.querySelectorAll("input")) for (const kind of ["input", "change"]) el.addEventListener(kind, () => events.push(el.id + ":" + kind));
  </script>
  """

private let addressForm = """
  <!doctype html><style>input, textarea { position: absolute; left: 10px; width: 200px; height: 20px; }</style>
  <form><input id="name" autocomplete="name" style="top: 10px"><input id="org" autocomplete="organization" style="top: 40px">
  <textarea id="street" autocomplete="street-address" style="top: 70px"></textarea><input id="city" autocomplete="address-level2" style="top: 100px"></form>
  <script>
  window.events = [];
  for (const el of document.querySelectorAll("input, textarea")) for (const kind of ["input", "change"]) el.addEventListener(kind, () => events.push(el.id + ":" + kind));
  </script>
  """

@MainActor private final class RecordingWebView: WKWebView, WKNavigationDelegate, WKScriptMessageHandler {
  var sources: [String] = []
  var token: String?
  let host = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
  private var loaded: CheckedContinuation<Void, Never>?
  private var reported: CheckedContinuation<Void, Never>?

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

  func load(_ html: String) async {
    navigationDelegate = self
    host.contentView = self
    await withCheckedContinuation { loaded = $0; loadHTMLString(html, baseURL: URL(string: origin + "/checkout")) }
  }

  nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    MainActor.assumeIsolated {
      loaded?.resume()
      loaded = nil
    }
  }

  nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated {
      guard let body = message.body as? [String: Any], let data = body["data"] as? [String: Any], data["event"] as? String == "show" else { return }
      token = data["token"] as? String
      reported?.resume()
      reported = nil
    }
  }

  func press(atTop top: CGFloat) async {
    let point = NSPoint(x: 20, y: bounds.height - top - 10)
    let down = NSEvent.mouseEvent(
      with: .leftMouseDown, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: host.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    await withCheckedContinuation { reported = $0; mouseDown(with: down) }
  }

  func read(_ expression: String) async -> Any? {
    await withCheckedContinuation { done in
      super.__evaluateJavaScript(expression, inFrame: nil, in: .page) { value, _ in done.resume(returning: value) }
    }
  }
}

@MainActor private func page(_ html: String) async -> RecordingWebView {
  NSApplication.shared.setActivationPolicy(.prohibited)
  let configuration = WKWebViewConfiguration()
  let script = ProcessInfo.processInfo.environment["ARDIA_AUTOFILL_SCRIPT"] ?? ""
  configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: false, in: world))
  let view = RecordingWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: configuration)
  configuration.userContentController.add(view, contentWorld: world, name: "ardiaAutofill")
  await view.load(html)
  await view.press(atTop: 10)
  return view
}

@MainActor private func fill(_ view: RecordingWebView, kind: String, values: [String: Any]) async -> Int {
  await withCheckedContinuation { done in
    WebKitAutofillFill.run(in: view, frame: nil, world: world, token: view.token ?? "", kind: kind, values: values) { done.resume(returning: $0) }
  }
}

private let card: [String: Any] = ["name": cardName, "network": "visa", "number": cardNumber, "expMonth": 7, "expYear": 2031]
private let address: [String: Any] = ["name": addressName, "organization": organization, "street": street, "city": city]

@MainActor @Suite(.serialized) struct WebKitAutofillFillAsData {
  @Test func `a card lands in the fields byte for byte, with input and change events`() async {
    let view = await page(cardForm)
    #expect(await fill(view, kind: "card", values: card) == 4)
    #expect(await view.read("document.getElementById('name').value") as? String == cardName)
    #expect(await view.read("document.getElementById('number').value") as? String == cardNumber)
    #expect(await view.read("document.getElementById('month').value") as? String == "07")
    #expect(await view.read("document.getElementById('year').value") as? String == "2031")
    #expect(await view.read("events.join(',')") as? String == "name:input,name:change,number:input,number:change,month:input,month:change,year:input,year:change")
  }

  @Test func `a card saved without an expiry still fills its name and number`() async {
    let view = await page(cardForm)
    var undated = card
    undated["expMonth"] = NSNull()
    undated["expYear"] = NSNull()
    #expect(await fill(view, kind: "card", values: undated) == 2)
    #expect(await view.read("document.getElementById('number').value") as? String == cardNumber)
    #expect(await view.read("document.getElementById('month').value") as? String == "")
  }

  @Test func `an address lands in the fields byte for byte, with input and change events`() async {
    let view = await page(addressForm)
    #expect(await fill(view, kind: "address", values: address) == 4)
    #expect(await view.read("document.getElementById('name').value") as? String == addressName)
    #expect(await view.read("document.getElementById('org').value") as? String == organization)
    #expect(await view.read("document.getElementById('street').value") as? String == street)
    #expect(await view.read("document.getElementById('city').value") as? String == city)
    #expect(await view.read("events.join(',')") as? String == "name:input,name:change,org:input,org:change,street:input,street:change,city:input,city:change")
  }

  @Test func `no script source handed to the page holds a card or address value`() async {
    for (html, kind, values) in [(cardForm, "card", card), (addressForm, "address", address)] {
      let view = await page(html)
      view.sources = []
      #expect(await fill(view, kind: kind, values: values) > 0)
      #expect(!view.sources.isEmpty)
      for source in view.sources {
        for secret in ["O'Neil", "411111", "Zoë", "Acme", "O'Hare", "Saint-Jean", "alert(", "</script>", "💳"] { #expect(!source.contains(secret)) }
      }
    }
  }

  @Test func `a fill with the wrong token leaves the fields empty`() async {
    let view = await page(cardForm)
    view.token = "not-the-page-token"
    #expect(await fill(view, kind: "card", values: card) == 0)
    #expect(await view.read("document.getElementById('number').value") as? String == "")
  }
}
