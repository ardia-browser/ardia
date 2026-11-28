import Foundation
import Testing
import WebKit
@testable import ArdiaBrowser

let adShieldCondition = "/error-report|adShieldError/"
let adShieldFilter = "allrecipes.com,people.com##+js(trusted-replace-argument, Element.prototype.setAttribute, 1, , condition, '\(adShieldCondition)')"
let adShieldBody = ["trusted-replace-argument", "Element.prototype.setAttribute", "1", "", "condition", adShieldCondition]

@Suite struct ScriptletTableTests {
  @Test func readsUBlockOriginsArgumentsAndQuotes() {
    #expect(ScriptletTable.arguments(#"a, 'b, c', "d\"e", f\,g ,  , `h`"#) == ["a", "b, c", "d\"e", "f,g", "", "h"])
    #expect(ScriptletTable.arguments("") == [])
    #expect(ScriptletTable.arguments("a, 'open") == nil)
    #expect(ScriptletTable.arguments("'a' b") == nil)
  }

  @Test func trustedScriptletsComeOnlyFromUBlockOriginsOwnLists() {
    let trusted = FilterListConverter.parse(adShieldFilter, id: "ublock-filters")
    #expect(trusted.convertedLines == 1)
    #expect(trusted.scriptlets.bodies(forHost: "www.allrecipes.com") == [adShieldBody])
    #expect(trusted.scriptlets.bodies(forHost: "people.com") == [adShieldBody])
    for id in ["easylist", "adguard-mobile", "custom-0123456789ab", FilterLists.myFiltersID] {
      let list = FilterListConverter.parse(adShieldFilter, id: id)
      #expect(list.scriptlets.isEmpty, "\(id) must not run trusted scriptlets")
      #expect(list.skippedLines == 1)
    }
  }

  @Test func keepsOnlyScopedScriptletsArdiaRunsAndHonoursExceptions() {
    let text = """
    ##+js(trusted-replace-argument, foo, 0, x)
    example.com##+js(nobab)
    shop.example,~other.example##+js(trusted-ra.js, Element.prototype.setAttribute, 1, )
    google.*##+js(trusted-replace-argument, a, 0, b)
    shop.example##+js(trusted-replace-argument, 'unclosed)
    sub.shop.example#@#+js(trusted-replace-argument, Element.prototype.setAttribute, 1, )
    quiet.example#@#+js()
    quiet.example##+js(trusted-replace-argument, a, 0, b)
    """
    let list = FilterListConverter.parse(text, id: "ublock-filters")
    #expect(list.skippedLines == 4)
    #expect(list.scriptlets.bodies(forHost: "shop.example") == [["trusted-replace-argument", "Element.prototype.setAttribute", "1", ""]])
    #expect(list.scriptlets.bodies(forHost: "www.shop.example") == [["trusted-replace-argument", "Element.prototype.setAttribute", "1", ""]])
    #expect(list.scriptlets.bodies(forHost: "sub.shop.example").isEmpty)
    #expect(list.scriptlets.bodies(forHost: "quiet.example").isEmpty)
    #expect(list.scriptlets.bodies(forHost: "other.example").isEmpty)
    #expect(list.scriptlets.bodies(forHost: nil).isEmpty)
  }

  @Test func exceptionsFromOneListLiftAnothersScriptlets() {
    var table = FilterListConverter.parse(adShieldFilter, id: "ublock-filters").scriptlets
    table.merge(FilterListConverter.parse("people.com#@#+js(trusted-replace-argument, Element.prototype.setAttribute, 1, , condition, '\(adShieldCondition)')", id: FilterLists.myFiltersID).scriptlets)
    #expect(table.bodies(forHost: "people.com").isEmpty)
    #expect(table.bodies(forHost: "allrecipes.com") == [adShieldBody])
  }
}

@MainActor
enum ScriptletPages {
  static let probe = """
  <!doctype html><html><body><script>
  const slot = document.createElement("div");
  slot.setAttribute("data-load", "fetch(url).then(adShieldError)");
  slot.setAttribute("data-keep", "plain value");
  window.__load = slot.getAttribute("data-load");
  window.__keep = slot.getAttribute("data-keep");
  window.__native = Element.prototype.setAttribute.toString().includes("[native code]");
  window.__nonce = "NONCE";
  </script></body></html>
  """

  static func run(host: String, nonce: String, in webView: WKWebView) async throws -> (load: String?, keep: String?, native: Bool?) {
    try await NightShadePages.load(probe.replacingOccurrences(of: "NONCE", with: nonce), host: host, nonce: nonce, into: webView)
    let load = try await webView.evaluateJavaScript("window.__load") as? String
    let keep = try await webView.evaluateJavaScript("window.__keep") as? String
    let native = try await webView.evaluateJavaScript("window.__native") as? Bool
    return (load, keep, native)
  }
}

@MainActor
@Suite(.serialized) struct ScriptletRuntimeTests {
  @Test func replacesOnlyTheMatchingArgumentOnTheListedSitesAndLooksNative() async throws {
    let table = FilterListConverter.parse(adShieldFilter, id: "ublock-filters").scriptlets
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.addUserScript(WKUserScript(source: try #require(table.script), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: configuration)

    let listed = try await ScriptletPages.run(host: "www.allrecipes.com", nonce: "listed", in: webView)
    #expect(listed.load == "")
    #expect(listed.keep == "plain value")
    #expect(listed.native == true)

    let other = try await ScriptletPages.run(host: "example.org", nonce: "other", in: webView)
    #expect(other.load == "fetch(url).then(adShieldError)")
  }

  @Test func anEmptyTableHasNoScript() {
    #expect(ScriptletTable().script == nil)
  }
}

@MainActor
@Suite(.serialized) struct ScriptletBlockingTests {
  @Test func listsCarryTheirScriptletsIntoPagesAndFollowTheSwitchesAndTrustedSites() async throws {
    let fixture = FilterListsFixture(catalog: [FilterListsFixture.entry("ublock-filters"), FilterListsFixture.entry("easylist")])
    let suite = "ardia.scriptlets.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer {
      fixture.cleanUp()
      defaults.removePersistentDomain(forName: suite)
    }
    StubProtocol.serve("\(fixture.base)/ublock-filters.txt", "! Title: uBlock filters\n" + adShieldFilter)
    StubProtocol.serve("\(fixture.base)/easylist.txt", "! Title: EasyList\n||ads.example^\n" + adShieldFilter)
    await fixture.lists.updateNow()
    #expect(Set(fixture.lists.scriptlets.keys) == ["ublock-filters"])

    let reloaded = FilterLists(directory: fixture.directory, defaults: fixture.defaults, session: StubProtocol.session, languages: ["en-US"], isMobile: true, catalog: fixture.lists.catalog)
    await reloaded.loadCompiled()
    #expect(reloaded.scriptlets == fixture.lists.scriptlets)

    let settings = BlockingSettings(defaults: defaults)
    let blocker = ContentBlocker(settings: settings, directory: fixture.directory.appending(path: "Blocker"), filterLists: reloaded)
    await blocker.prepare()
    var counted: [Bool] = []
    blocker.onScriptletPage = { counted.append($0) }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let controller = configuration.userContentController
    blocker.install(on: controller, counter: BlockedResourceCounter())
    let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: configuration)
    let pageScript = WKUserScript(source: "window.__other = true", injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient)
    func navigate(_ nonce: String) async throws -> String? {
      blocker.prepareNavigation(of: controller, toHost: "www.allrecipes.com")
      blocker.countScriptletPage(toHost: "www.allrecipes.com")
      controller.removeAllUserScripts()
      blocker.restoreUserScripts(on: controller)
      controller.addUserScript(pageScript)
      return try await ScriptletPages.run(host: "www.allrecipes.com", nonce: nonce, in: webView).load
    }

    #expect(try await navigate("on") == "")
    #expect(counted == [false])
    #expect(controller.userScripts.count(where: { $0.source.contains("trusted-replace-argument") }) == 1)

    settings.setExempt("www.allrecipes.com", true)
    #expect(try await navigate("trusted") == "fetch(url).then(adShieldError)")
    #expect(counted == [false])
    #expect(controller.userScripts.contains { $0 === pageScript })

    settings.setExempt("www.allrecipes.com", false)
    #expect(try await navigate("again") == "")
    #expect(counted == [false, false])

    settings.blocksAds = false
    #expect(try await navigate("off") == "fetch(url).then(adShieldError)")
    #expect(counted == [false, false])
    #expect(!controller.userScripts.contains { $0.source.contains("trusted-replace-argument") })
  }
}
