import AppKit
import Foundation
import Testing
import WebKit

private let world = WKContentWorld.world(name: "ardia")
private let page = "https://page.test"
private let otherSite = "https://bank.test"
private let events: Set<String> = ["show", "input", "key", "hide", "passwordInput"]
private let keys: Set<String> = ["down", "up", "enter", "escape", "tab"]

private struct Posted {
  let kind: String
  let data: [String: Any]
  let origin: WKSecurityOrigin
}

@MainActor private final class Collector: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  var posted: [Posted] = []
  var received = 0
  private var finished: CheckedContinuation<Int, Never>?
  private var loaded: CheckedContinuation<Void, Never>?

  nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated {
      guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
      if kind == "done" {
        finished?.resume(returning: (body["data"] as? NSNumber)?.intValue ?? -1)
        finished = nil
        return
      }
      received += 1
      guard let data = body["data"] as? [String: Any] else { return }
      posted.append(Posted(kind: kind, data: data, origin: message.frameInfo.securityOrigin))
    }
  }

  nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    MainActor.assumeIsolated {
      loaded?.resume()
      loaded = nil
    }
  }

  func open() async -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(self, contentWorld: world, name: "ardia")
    let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: configuration)
    view.navigationDelegate = self
    await withCheckedContinuation { loaded = $0; view.loadHTMLString("<!doctype html><p>fixture</p>", baseURL: URL(string: page + "/login")) }
    return view
  }

  func run(_ source: String, in view: WKWebView) async -> Int {
    await withCheckedContinuation { done in
      finished = done
      view.evaluateJavaScript(source + "\nwebkit.messageHandlers.ardia.postMessage({ kind: \"done\", data: sent, frame: \"logins\" });", in: nil, in: world) { _ in }
    }
  }
}

private let hostile = ProcessInfo.processInfo.environment["ARDIA_HOSTILE_INPUTS"] ?? ""

private let messages = """
  const SHOW = { event: "show", origin: location.origin, password: false, code: false, newPassword: false, value: "ada", x: 10, y: 20, width: 300, height: 30 };
  const NEW = { ...SHOW, password: true, newPassword: true, value: "", maxLength: 20, minLength: 8, pattern: "[a-z]+" };
  const KEY = { event: "key", key: "down", origin: location.origin };
  const MARKS = "a" + "\\u0301".repeat(10000);
  const SUBMIT = { username: "ada", password: "fixture-pw-ada-1", origin: location.origin, field: { name: "pass", id: "p", autocomplete: "current-password" } };
  let sent = 0;
  const post = (kind, data) => {
    try {
      webkit.messageHandlers.ardia.postMessage({ kind, data, frame: "logins" });
      sent += 1;
    } catch (e) {}
  };
  post("loginField", SHOW);
  post("loginField", NEW);
  post("loginField", KEY);
  post("loginField", { ...SHOW, origin: "\(otherSite)" });
  post("loginField", { ...SHOW, value: MARKS });
  post("loginField", { ...NEW, pattern: MARKS });
  post("loginSubmit", SUBMIT);
  post("loginSubmit", { ...SUBMIT, origin: "\(otherSite)" });
  post("loginSubmit", { ...SUBMIT, username: "a".repeat(1024), password: "p".repeat(1024) });
  post("loginSubmit", { ...SUBMIT, password: "p".repeat(1025) });
  for (const { value } of HOSTILE_VALUES) {
    post("loginField", value);
    for (const name of [...Object.keys(SHOW), "key", "maxLength", "minLength", "pattern"]) {
      post("loginField", { ...SHOW, [name]: value });
      post("loginField", { ...NEW, [name]: value });
      post("loginField", { ...KEY, [name]: value });
    }
    for (const name of Object.keys(SUBMIT)) post("loginSubmit", { ...SUBMIT, [name]: value });
    if (typeof value === "string") {
      post("loginSubmit", { ...SUBMIT, username: `ada${value}`, password: `pw${value}` });
      post("loginSubmit", { ...SUBMIT, password: `${value}pw` });
    }
  }
  """

private func units(_ text: String) -> Int { text.utf16.count }

private func finite(_ rect: NSRect) -> Bool {
  [rect.minX, rect.minY, rect.width, rect.height].allSatisfy { $0.isFinite && abs($0) <= 1e6 } && rect.width >= 1 && rect.height >= 1
}

private func withinContract(_ report: WebKitLoginsReport) -> Bool {
  guard events.contains(report.event) else { return false }
  if report.event == "key" { return keys.contains(report.key) }
  guard report.event == "show" || report.event == "input" else { return report.typed.isEmpty }
  let rules = report.rules
  let rulesFit = (0...1024).contains(rules.minLength) && (0...1024).contains(rules.maxLength)
  let typedFits = units(report.typed) <= 200 && (report.typed.isEmpty || (report.kind == .login && !report.password))
  return finite(report.rect) && rulesFit && typedFits
}

private func wellFormed(_ text: String) -> Bool {
  let units = text as NSString
  var i = 0
  while i < units.length {
    let unit = units.character(at: i)
    if unit == 0 || UTF16.isTrailSurrogate(unit) { return false }
    if UTF16.isLeadSurrogate(unit) {
      guard i + 1 < units.length, UTF16.isTrailSurrogate(units.character(at: i + 1)) else { return false }
      i += 1
    }
    i += 1
  }
  return true
}

private func savable(_ login: (username: String, password: String)) -> Bool {
  !login.password.isEmpty && [login.username, login.password].allSatisfy { units($0) <= 1024 && wellFormed($0) }
}

@MainActor @Suite(.serialized) struct WebKitLoginReportGuards {
  @Test func `B1: every hostile value in every field of a WebKit loginField message is refused or kept within the report's contract`() async {
    let collector = Collector()
    let view = await collector.open()
    let sent = await collector.run(hostile + "\n" + messages, in: view)
    #expect(sent > 1000)
    #expect(collector.received == sent, "every post the page made reached native")
    let field = { (i: Int) in WebKitLoginsReport.read(collector.posted[i].data) }
    #expect(field(0)?.typed == "ada" && field(0)?.kind == .login && field(0)?.rect == NSRect(x: 10, y: 20, width: 300, height: 30))
    #expect(field(1)?.kind == .newPassword && field(1)?.rules == StrongPassword.Rules(minLength: 8, maxLength: 20) && field(1)?.typed == "")
    #expect(field(2)?.event == "key" && field(2)?.key == "down")
    #expect(field(4)?.typed == "", "a typed value of one character with 10,000 marks is cut at a character boundary within 200 units")
    #expect(field(5)?.rules == StrongPassword.Rules(minLength: 8, maxLength: 20), "a page's pattern, however long, is never kept")
    var kept = 0
    var broken: [String] = []
    for message in collector.posted where message.kind == "loginField" {
      guard WebKitLoginsReport.frameOrigin(message.origin, claimed: message.data["origin"]) != nil, let report = WebKitLoginsReport.read(message.data) else { continue }
      kept += 1
      if !withinContract(report) {
        broken.append("\(report.event) key=\(report.key.prefix(20)) typed=\(units(report.typed)) rect=\(report.rect)")
      }
    }
    #expect(kept > 100, "some reports still go through, so the contract check ran on real ones")
    #expect(broken.isEmpty, "\(broken.count) reports broke the contract, first: \(broken.prefix(5))")
  }

  @Test func `B2: a loginField message naming another site's origin, or any hostile origin, has no frame origin; native uses only the frame's own`() async {
    let collector = Collector()
    let view = await collector.open()
    _ = await collector.run(hostile + "\n" + messages, in: view)
    let fields = collector.posted.filter { $0.kind == "loginField" }
    let frames = fields.map { WebKitLoginsReport.frameOrigin($0.origin, claimed: $0.data["origin"]) }
    #expect(frames.first == page, "the frame's own origin goes through")
    #expect(fields[3].data["origin"] as? String == otherSite)
    #expect(frames[3] == nil, "a message claiming another site is refused")
    #expect(frames.allSatisfy { $0 == nil || $0 == page }, "no message makes native use an origin other than the frame's")
    let claimedOther = zip(fields, frames).filter { ($0.0.data["origin"] as? String).map(WebKitLoginsReport.normalized) != page }
    #expect(!claimedOther.isEmpty)
    #expect(claimedOther.allSatisfy { $0.1 == nil })
  }

  @Test func `B1: every hostile value in a WebKit loginSubmit message is refused or saved only as a bounded, well-formed login of the frame's own site`() async {
    let collector = Collector()
    let view = await collector.open()
    _ = await collector.run(hostile + "\n" + messages, in: view)
    let submits = collector.posted.filter { $0.kind == "loginSubmit" }
    let login = { (i: Int) in ApplePasswordsMatch.savable(username: submits[i].data["username"], password: submits[i].data["password"]) }
    #expect(submits.count > 200)
    #expect(login(0)?.username == "ada" && login(0)?.password == "fixture-pw-ada-1", "a real login still goes through")
    #expect(WebKitLoginsReport.frameOrigin(submits[0].origin, claimed: submits[0].data["origin"]) == page)
    #expect(WebKitLoginsReport.frameOrigin(submits[1].origin, claimed: submits[1].data["origin"]) == nil, "a submit claiming another site saves nothing")
    #expect(login(2)?.password.utf16.count == 1024, "a 1024-unit login is kept whole")
    #expect(login(3)?.password.utf16.count == nil, "a password past 1024 units is refused, not cut")
    var kept = 0
    var broken: [String] = []
    for submit in submits {
      guard WebKitLoginsReport.frameOrigin(submit.origin, claimed: submit.data["origin"]) == page,
        let saved = ApplePasswordsMatch.savable(username: submit.data["username"], password: submit.data["password"])
      else { continue }
      kept += 1
      if !savable(saved) { broken.append("username \(units(saved.username)) units, password \(units(saved.password)) units, well formed \(wellFormed(saved.username)) \(wellFormed(saved.password))") }
    }
    #expect(kept > 50)
    #expect(broken.isEmpty, "\(broken.count) logins broke the contract, first: \(broken.prefix(5))")
  }
}
