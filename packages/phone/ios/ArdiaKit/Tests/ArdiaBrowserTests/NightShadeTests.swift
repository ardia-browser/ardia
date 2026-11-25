import ArdiaSync
import Foundation
import SwiftData
import Testing
import WebKit
@testable import ArdiaBrowser

@MainActor
enum NightShadePages {
  static func probing(background: String, nonce: String) -> String {
    """
    <!doctype html><html><head>
    <script>window.__headSaw = !!document.getElementById("ardia-night-shade")</script>
    <style>body{background:\(background);color:#888}</style></head>
    <body><script>window.__bodySaw = !!document.getElementById("ardia-night-shade")</script>
    <p>Article text</p><script>window.__nonce = "\(nonce)"</script></body></html>
    """
  }

  static func load(_ html: String, host: String, nonce: String, into webView: WKWebView) async throws {
    webView.loadHTMLString(html, baseURL: URL(string: "https://\(host)/"))
    try await waitUntil("page \(nonce) on \(host) loaded") {
      let script = "window.__nonce === \"\(nonce)\" && document.readyState === \"complete\""
      return (try? await webView.evaluateJavaScript(script)) as? Bool == true
    }
  }

  static func flag(_ name: String, in webView: WKWebView?) async throws -> Bool? {
    try await webView?.evaluateJavaScript("window.\(name)") as? Bool
  }

  static func isShaded(_ webView: WKWebView?) async throws -> Bool? {
    try await webView?.evaluateJavaScript("!!document.getElementById(\"ardia-night-shade\")") as? Bool
  }

  static func waitUntil(_ what: String, seconds: Double = 20, _ check: @MainActor () async -> Bool) async throws {
    let deadline = Date.now.addingTimeInterval(seconds)
    while Date.now < deadline {
      if await check() { return }
      try await Task.sleep(for: .milliseconds(25))
    }
    Issue.record("timed out waiting for \(what)")
    throw CancellationError()
  }
}

@MainActor
final class NightShadeHandler: NSObject, WKScriptMessageHandlerWithReply {
  var mode: NightShadeMode
  var asked = 0
  var verdicts: [String] = []

  init(mode: NightShadeMode) {
    self.mode = mode
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return (nil, nil) }
    switch type {
    case "nightShade":
      asked += 1
      return (mode.rawValue, nil)
    case "nightShadeVerdict":
      if let verdict = body["verdict"] as? String { verdicts.append(verdict) }
      return (nil, nil)
    default:
      return (nil, nil)
    }
  }
}

@MainActor
@Suite(.serialized) struct NightShadeScriptTests {
  func webView(_ bake: NightShadeBake?, handler: NightShadeHandler) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.addScriptMessageHandler(handler, contentWorld: ReadableContent.world, name: PageScripts.handlerName)
    configuration.userContentController.addUserScript(WKUserScript(source: PageScripts.nightShade(bake), injectionTime: .atDocumentStart, forMainFrameOnly: true, in: ReadableContent.world))
    return WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 800), configuration: configuration)
  }

  @Test func theBakedStateIsValidScript() {
    #expect(!PageScripts.nightShade(nil).contains(PageScripts.bakedStatePlaceholder))
    #expect(PageScripts.nightShade(NightShadeBake(mode: .always, verdict: .light)).contains(#"{"mode":"always","verdict":"light"}"#))
    #expect(PageScripts.nightShade(NightShadeBake(mode: .automatic, verdict: nil)).contains(#"{"mode":"automatic","verdict":null}"#))
  }

  @Test func aBakedLightVerdictShadesThePageBeforeItsFirstScript() async throws {
    let handler = NightShadeHandler(mode: .always)
    let view = webView(NightShadeBake(mode: .always, verdict: .light), handler: handler)
    try await NightShadePages.load(NightShadePages.probing(background: "#fff", nonce: "1"), host: "light.example", nonce: "1", into: view)
    #expect(try await NightShadePages.flag("__headSaw", in: view) == true)
    #expect(try await NightShadePages.flag("__bodySaw", in: view) == true)
    #expect(try await NightShadePages.isShaded(view) == true)
    #expect(handler.asked == 0)
    #expect(handler.verdicts.isEmpty)
  }

  @Test func anUnknownSiteIsMeasuredOnceItsBodyExistsAndReported() async throws {
    let handler = NightShadeHandler(mode: .always)
    let view = webView(NightShadeBake(mode: .always, verdict: nil), handler: handler)
    try await NightShadePages.load(NightShadePages.probing(background: "#fff", nonce: "1"), host: "new.example", nonce: "1", into: view)
    #expect(try await NightShadePages.flag("__headSaw", in: view) == false)
    #expect(try await NightShadePages.flag("__bodySaw", in: view) == true)
    #expect(try await NightShadePages.isShaded(view) == true)
    try await NightShadePages.waitUntil("a light verdict") { handler.verdicts == ["light"] }
  }

  @Test func aSiteWithItsOwnDarkLookIsLeftAloneAndReportedDark() async throws {
    let handler = NightShadeHandler(mode: .always)
    let view = webView(NightShadeBake(mode: .always, verdict: nil), handler: handler)
    try await NightShadePages.load(NightShadePages.probing(background: "#111", nonce: "1"), host: "dark.example", nonce: "1", into: view)
    #expect(try await NightShadePages.isShaded(view) == false)
    try await NightShadePages.waitUntil("a dark verdict") { handler.verdicts == ["dark"] }
  }

  @Test func aStaleVerdictIsCorrectedAndReported() async throws {
    let handler = NightShadeHandler(mode: .always)
    let view = webView(NightShadeBake(mode: .always, verdict: .light), handler: handler)
    try await NightShadePages.load(NightShadePages.probing(background: "#111", nonce: "1"), host: "redesigned.example", nonce: "1", into: view)
    #expect(try await NightShadePages.flag("__headSaw", in: view) == true)
    #expect(try await NightShadePages.isShaded(view) == false)
    try await NightShadePages.waitUntil("a dark verdict") { handler.verdicts == ["dark"] }
  }

  @Test func aMatchingVerdictSendsNothing() async throws {
    let handler = NightShadeHandler(mode: .always)
    let view = webView(NightShadeBake(mode: .always, verdict: .dark), handler: handler)
    try await NightShadePages.load(NightShadePages.probing(background: "#111", nonce: "1"), host: "dark.example", nonce: "1", into: view)
    try await Task.sleep(for: .milliseconds(200))
    #expect(try await NightShadePages.isShaded(view) == false)
    #expect(handler.verdicts.isEmpty)
  }

  @Test func offMeasuresAndReportsNothing() async throws {
    let handler = NightShadeHandler(mode: .disabled)
    let view = webView(NightShadeBake(mode: .disabled, verdict: nil), handler: handler)
    try await NightShadePages.load(NightShadePages.probing(background: "#fff", nonce: "1"), host: "light.example", nonce: "1", into: view)
    try await Task.sleep(for: .milliseconds(200))
    #expect(try await NightShadePages.isShaded(view) == false)
    #expect(handler.verdicts.isEmpty)
  }

  @Test func withoutABakedStateItAsksAtDocumentStart() async throws {
    let handler = NightShadeHandler(mode: .always)
    let view = webView(nil, handler: handler)
    try await NightShadePages.load(NightShadePages.probing(background: "#fff", nonce: "1"), host: "light.example", nonce: "1", into: view)
    #expect(handler.asked == 1)
    #expect(try await NightShadePages.isShaded(view) == true)
    try await NightShadePages.waitUntil("a light verdict") { handler.verdicts == ["light"] }
  }
}

@MainActor
@Suite struct NightShadeVerdictsTests {
  func fresh() -> (UserDefaults, String) {
    let suite = "ardia.nightshade.verdicts.\(UUID().uuidString)"
    return (UserDefaults(suiteName: suite)!, suite)
  }

  @Test func verdictsPersistPerSiteIgnoringWww() {
    let (defaults, suite) = fresh()
    defer { defaults.removePersistentDomain(forName: suite) }
    NightShadeVerdicts(defaults: defaults).record(.light, for: "www.Yahoo.com")
    let relaunched = NightShadeVerdicts(defaults: defaults)
    #expect(relaunched.verdict(for: "yahoo.com") == .light)
    relaunched.record(.dark, for: "yahoo.com")
    #expect(NightShadeVerdicts(defaults: defaults).verdict(for: "www.yahoo.com") == .dark)
    #expect(relaunched.count == 1)
  }

  @Test func theOldestSiteGoesFirstPastTheCap() {
    let (defaults, suite) = fresh()
    defer { defaults.removePersistentDomain(forName: suite) }
    let verdicts = NightShadeVerdicts(defaults: defaults)
    for index in 0..<NightShadeVerdicts.limit { verdicts.record(.light, for: "site\(index).example") }
    verdicts.record(.dark, for: "site0.example")
    verdicts.record(.light, for: "new.example")
    let relaunched = NightShadeVerdicts(defaults: defaults)
    #expect(relaunched.count == NightShadeVerdicts.limit)
    #expect(relaunched.verdict(for: "site1.example") == nil)
    #expect(relaunched.verdict(for: "site0.example") == .dark)
    #expect(relaunched.verdict(for: "site2.example") == .light)
    #expect(relaunched.verdict(for: "new.example") == .light)
  }

  @Test func privateVerdictsStayInMemoryAndEndWithPrivateBrowsing() {
    let (defaults, suite) = fresh()
    defer { defaults.removePersistentDomain(forName: suite) }
    let verdicts = NightShadeVerdicts(defaults: defaults)
    verdicts.record(.light, for: "normal.example")
    verdicts.record(.dark, for: "secret.example", isPrivate: true)
    #expect(verdicts.verdict(for: "secret.example", isPrivate: true) == .dark)
    #expect(verdicts.verdict(for: "normal.example", isPrivate: true) == .light)
    #expect(verdicts.verdict(for: "secret.example") == nil)
    #expect(NightShadeVerdicts(defaults: defaults).verdict(for: "secret.example", isPrivate: true) == nil)
    #expect(String(data: defaults.data(forKey: NightShadeVerdicts.key) ?? Data(), encoding: .utf8)?.contains("secret") == false)
    verdicts.endPrivateBrowsing()
    #expect(verdicts.verdict(for: "secret.example", isPrivate: true) == nil)
  }

  @Test func clearingHistoryOrSiteDataClearsVerdicts() async throws {
    let (defaults, suite) = fresh()
    defer { defaults.removePersistentDomain(forName: suite) }
    var now = Date(timeIntervalSinceReferenceDate: 800_000_000)
    let verdicts = NightShadeVerdicts(defaults: defaults) { now }
    verdicts.record(.light, for: "old.example")
    now = now.addingTimeInterval(3600)
    verdicts.record(.dark, for: "recent.example")
    let container = try BrowserStore.makeContainer(.inMemory)
    let tabs = TabStore(context: container.mainContext, defaults: defaults)
    await BrowsingDataCleaner.clear([.cache], tabs: tabs, nightShadeVerdicts: verdicts)
    #expect(verdicts.count == 2)
    await BrowsingDataCleaner.clear([.history], since: now.addingTimeInterval(-60), tabs: tabs, nightShadeVerdicts: verdicts)
    #expect(verdicts.verdict(for: "recent.example") == nil)
    #expect(NightShadeVerdicts(defaults: defaults).verdict(for: "old.example") == .light)
    verdicts.clear()
    #expect(NightShadeVerdicts(defaults: defaults).count == 0)
  }
}

#if canImport(UIKit)
@MainActor
struct NightShadeEngineFixture {
  let container: ModelContainer
  let defaults: UserDefaults
  let suite: String
  let engine: WebEngine
  let directory: URL

  init() throws {
    container = try BrowserStore.makeContainer(.inMemory)
    suite = "ardia.nightshade.\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suite)!
    directory = FileManager.default.temporaryDirectory.appending(path: suite, directoryHint: .isDirectory)
    let tabs = TabStore(context: container.mainContext, defaults: defaults)
    let blocker = ContentBlocker(settings: BlockingSettings(defaults: defaults), directory: directory)
    engine = WebEngine(tabs: tabs, blocker: blocker, preferences: BrowsingPreferences(defaults: defaults))
  }

  var verdicts: NightShadeVerdicts { engine.preferences.nightShadeVerdicts }

  func cleanUp() {
    defaults.removePersistentDomain(forName: suite)
    try? FileManager.default.removeItem(at: directory)
  }

  func liveTab(isPrivate: Bool = false) throws -> WebTab {
    let tab = engine.tabs.open(.url(URL(string: "\(BrowserURL.browseScheme)://blank")!), isPrivate: isPrivate)
    let page = try #require(engine.webTab(for: tab.id))
    page.makeLive()
    _ = try #require(page.webView)
    return page
  }

  func load(_ background: String, host: String, nonce: String, into page: WebTab) async throws {
    try await NightShadePages.load(NightShadePages.probing(background: background, nonce: nonce), host: host, nonce: nonce, into: try #require(page.webView))
  }

  func baked(_ page: WebTab) -> WebEngine.BakedNightShade? {
    page.webView.flatMap { engine.bakedNightShade(of: $0.configuration.userContentController) }
  }
}

@MainActor
@Suite(.serialized) struct NightShadeEngineTests {
  @Test func aSecondLoadOfALightSiteIsShadedBeforeTheBodyRuns() async throws {
    let fixture = try NightShadeEngineFixture()
    defer { fixture.cleanUp() }
    fixture.engine.preferences.nightShade = .always
    let page = try fixture.liveTab()
    try await fixture.load("#fff", host: "light.example", nonce: "first", into: page)
    let firstHeadSaw = try await NightShadePages.flag("__headSaw", in: page.webView)
    #expect(firstHeadSaw == false)
    try await NightShadePages.waitUntil("the light verdict") { fixture.verdicts.verdict(for: "light.example") == .light }
    try await fixture.load("#fff", host: "light.example", nonce: "second", into: page)
    let headSaw = try await NightShadePages.flag("__headSaw", in: page.webView)
    let bodySaw = try await NightShadePages.flag("__bodySaw", in: page.webView)
    #expect(headSaw == true)
    #expect(bodySaw == true)
  }

  @Test func theFirstLoadRecordsLightAndDarkSites() async throws {
    let fixture = try NightShadeEngineFixture()
    defer { fixture.cleanUp() }
    fixture.engine.preferences.nightShade = .always
    let page = try fixture.liveTab()
    try await fixture.load("#fff", host: "www.light.example", nonce: "light", into: page)
    try await NightShadePages.waitUntil("the light verdict") { fixture.verdicts.verdict(for: "light.example") == .light }
    try await fixture.load("#111", host: "dark.example", nonce: "dark", into: page)
    try await NightShadePages.waitUntil("the dark verdict") { fixture.verdicts.verdict(for: "dark.example") == .dark }
    #expect(try await NightShadePages.isShaded(page.webView) == false)
    let relaunched = NightShadeVerdicts(defaults: fixture.defaults)
    #expect(relaunched.verdict(for: "light.example") == .light)
    #expect(relaunched.verdict(for: "dark.example") == .dark)
  }

  @Test func privateVerdictsAreNeverSavedAndEndWithPrivateBrowsing() async throws {
    let fixture = try NightShadeEngineFixture()
    defer { fixture.cleanUp() }
    fixture.engine.preferences.nightShade = .always
    let page = try fixture.liveTab(isPrivate: true)
    try await fixture.load("#fff", host: "secret.example", nonce: "1", into: page)
    try await NightShadePages.waitUntil("the private verdict") { fixture.verdicts.verdict(for: "secret.example", isPrivate: true) == .light }
    #expect(fixture.verdicts.verdict(for: "secret.example") == nil)
    #expect(NightShadeVerdicts(defaults: fixture.defaults).verdict(for: "secret.example", isPrivate: true) == nil)
    #expect(fixture.defaults.data(forKey: NightShadeVerdicts.key) == nil)
    try await fixture.load("#fff", host: "secret.example", nonce: "2", into: page)
    #expect(try await NightShadePages.flag("__headSaw", in: page.webView) == true)
    fixture.engine.tabs.closeAllPrivate()
    #expect(fixture.verdicts.verdict(for: "secret.example", isPrivate: true) == nil)
  }

  @Test func eachNavigationBakesItsHostIntoTheTab() async throws {
    let fixture = try NightShadeEngineFixture()
    defer { fixture.cleanUp() }
    fixture.engine.preferences.nightShade = .always
    fixture.verdicts.record(.light, for: "light.example")
    fixture.verdicts.record(.dark, for: "dark.example")
    fixture.engine.preferences.update("off.example") { $0.nightShade = .disabled }
    let page = try fixture.liveTab()

    try await fixture.load("#fff", host: "light.example", nonce: "light", into: page)
    #expect(fixture.baked(page) == WebEngine.BakedNightShade(host: "light.example", isPrivate: false, state: NightShadeBake(mode: .always, verdict: .light)))
    #expect(try await NightShadePages.flag("__headSaw", in: page.webView) == true)

    try await fixture.load("#111", host: "dark.example", nonce: "dark", into: page)
    #expect(fixture.baked(page) == WebEngine.BakedNightShade(host: "dark.example", isPrivate: false, state: NightShadeBake(mode: .always, verdict: .dark)))
    #expect(try await NightShadePages.flag("__headSaw", in: page.webView) == false)
    #expect(try await NightShadePages.isShaded(page.webView) == false)

    try await fixture.load("#fff", host: "off.example", nonce: "off", into: page)
    #expect(fixture.baked(page)?.state == NightShadeBake(mode: .disabled, verdict: nil))
    #expect(try await NightShadePages.isShaded(page.webView) == false)

    try await fixture.load("#fff", host: "light.example", nonce: "again", into: page)
    #expect(try await NightShadePages.flag("__headSaw", in: page.webView) == true)
    #expect(page.webView?.configuration.userContentController.userScripts.count == 3)
  }

  @Test func changingTheSettingRebakesAndUpdatesTheOpenPage() async throws {
    let fixture = try NightShadeEngineFixture()
    defer { fixture.cleanUp() }
    fixture.engine.preferences.nightShade = .always
    fixture.verdicts.record(.light, for: "light.example")
    let page = try fixture.liveTab()
    try await fixture.load("#fff", host: "light.example", nonce: "1", into: page)
    #expect(try await NightShadePages.isShaded(page.webView) == true)

    fixture.engine.preferences.nightShade = .disabled
    #expect(fixture.baked(page)?.state == NightShadeBake(mode: .disabled, verdict: .light))
    try await NightShadePages.waitUntil("the shade to lift") { (try? await NightShadePages.isShaded(page.webView)) == false }

    fixture.engine.preferences.nightShade = .always
    #expect(fixture.baked(page)?.state == NightShadeBake(mode: .always, verdict: .light))
    try await NightShadePages.waitUntil("the shade to return") { (try? await NightShadePages.isShaded(page.webView)) == true }
  }
}
#endif
