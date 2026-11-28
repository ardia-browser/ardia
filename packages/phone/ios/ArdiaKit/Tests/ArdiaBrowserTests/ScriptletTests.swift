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
    babla.*,mixed.example##+js(trusted-replace-argument, a.b, 0, x)
    wide.example,~shop.wide.example##+js(trusted-replace-argument, a.b, 1, x)
    this.example##+js(trusted-replace-argument, a.b, this, x)
    repl.example##+js(trusted-replace-argument, a.b, 0, repl:/a/b/)
    """
    let list = FilterListConverter.parse(text, id: "ublock-filters")
    #expect(list.skippedLines == 6)
    #expect(list.scriptlets.bodies(forHost: "mixed.example") == [["trusted-replace-argument", "a.b", "0", "x"]])
    #expect(list.scriptlets.bodies(forHost: "www.wide.example") == [["trusted-replace-argument", "a.b", "1", "x"]])
    #expect(list.scriptlets.bodies(forHost: "shop.wide.example").isEmpty)
    #expect(list.scriptlets.bodies(forHost: "this.example").isEmpty)
    #expect(list.scriptlets.bodies(forHost: "repl.example").isEmpty)
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

  @Test func aDocumentExceptionStopsEveryScriptletOnTheSite() {
    var table = FilterListConverter.parse(adShieldFilter, id: "ublock-filters").scriptlets
    table.merge(FilterListConverter.parse("@@||allrecipes.com^$document", id: "easylist").scriptlets)
    #expect(table.bodies(forHost: "www.allrecipes.com").isEmpty)
    #expect(table.bodies(forHost: "people.com") == [adShieldBody])
  }

  @Test func onlyTheBlocksUBlockOriginOnSafariWouldReadApply() {
    let text = """
    !#if env_chromium
    ||chromium-only.example^
    chromium.example##+js(trusted-replace-argument, RegExp.prototype.test, 0, x)
    !#if ext_ublock
    ||nested-chromium.example^
    !#endif
    !#else
    ||not-chromium.example^
    !#endif
    !#if ext_ublock && !env_chromium
    ||safari-ublock.example^
    !#endif
    !#if (env_firefox || env_safari) && env_mobile
    ||mobile.example^
    !#endif
    !#if env_safari &&
    ||broken.example^
    !#endif
    ||after.example^
    """
    let list = FilterListConverter.parse(text, id: "ublock-filters")
    #expect(Set(list.blockedDomains) == ["not-chromium.example", "safari-ublock.example", "mobile.example", "after.example"])
    #expect(list.scriptlets.isEmpty)
  }

  @Test func deepOrLongPreparserExpressionsAreFalseNotACrash() {
    #expect(Preparser.holds(Substring(String(repeating: "!", count: 100_000) + "env_safari")) == false)
    #expect(Preparser.holds(Substring(String(repeating: "(", count: 100_000) + "env_safari" + String(repeating: ")", count: 100_000))) == false)
    #expect(Preparser.holds(Substring(String(repeating: "(", count: 8) + "env_safari" + String(repeating: ")", count: 8))) == true)
    #expect(Preparser.holds("!!env_safari") == true)
    #expect(Preparser.holds(Substring(String(repeating: "!", count: 20) + "env_safari")) == false)
    let text = "!#if " + String(repeating: "(", count: 50_000) + "\n||inside.example^\n!#endif\n||outside.example^"
    #expect(FilterListConverter.parse(text, id: "ublock-filters").blockedDomains == ["outside.example"])
  }

  @Test func replacementValuesMustBeOnesTheRuntimeCanUse() {
    let text = """
    good.example##+js(trusted-replace-argument, a.b, 0, 'json:{"x":[1,2]}')
    broken.example##+js(trusted-replace-argument, a.b, 0, 'json:{"x":')
    object.example##+js(trusted-replace-argument, a.b, 0, '{"value":"y"}')
    badobject.example##+js(trusted-replace-argument, a.b, 0, '{"value":')
    """
    let list = FilterListConverter.parse(text, id: "ublock-filters")
    #expect(list.skippedLines == 2)
    #expect(!list.scriptlets.bodies(forHost: "good.example").isEmpty)
    #expect(!list.scriptlets.bodies(forHost: "object.example").isEmpty)
    #expect(list.scriptlets.bodies(forHost: "broken.example").isEmpty)
    #expect(list.scriptlets.bodies(forHost: "badobject.example").isEmpty)
  }

  @Test func aTableWithAMissingBodyIsNotWellFormed() {
    var table = FilterListConverter.parse(adShieldFilter, id: "ublock-filters").scriptlets
    #expect(table.isWellFormed)
    table.hosts["allrecipes.com"] = [7]
    #expect(!table.isWellFormed)
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

  @Test func hostileArgumentTextStaysDataInThePageScript() async throws {
    let hostile = ["\u{2028}", "\u{2029}", "\u{0}", "</script><script>window.__ran=1</script>", "*/ window.__ran = 1; /*", "${window.__ran = 1}", "`", "\\", "\"'", "\u{FEFF}", "\u{202E}", String(repeating: "a", count: 4096)]
    var table = ScriptletTable()
    for (index, text) in hostile.enumerated() {
      table.add(["trusted-replace-argument", "Element.prototype.setAttribute", "1", "replaced \(index)", "condition", text], on: ["hostile.example"])
    }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.addUserScript(WKUserScript(source: try #require(table.script), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: configuration)
    _ = try await ScriptletPages.run(host: "hostile.example", nonce: "hostile", in: webView)
    for (index, text) in hostile.enumerated() {
      let set = "const node = document.createElement('div'); node.setAttribute('data-x', text); return node.getAttribute('data-x');"
      let result = try await webView.callAsyncJavaScript(set, arguments: ["text": text], in: nil, contentWorld: .page) as? String
      #expect(result?.hasPrefix("replaced ") == true, "argument \(index) did not reach the hook as data")
    }
    #expect(try await webView.evaluateJavaScript("window.__ran === undefined") as? Bool == true)
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

    let saved = try Data(contentsOf: fixture.lists.scriptletsURL)
    for tampered in [
      String(decoding: saved, as: UTF8.self).replacingOccurrences(of: #""build":""#, with: #""build":"other-"#),
      String(decoding: saved, as: UTF8.self).replacingOccurrences(of: #""allrecipes.com":[0]"#, with: #""allrecipes.com":[9]"#),
      "{",
    ] {
      try Data(tampered.utf8).write(to: fixture.lists.scriptletsURL)
      let stale = FilterLists(directory: fixture.directory, defaults: fixture.defaults, session: StubProtocol.session, languages: ["en-US"], isMobile: true, catalog: fixture.lists.catalog)
      await stale.loadCompiled()
      #expect(stale.scriptlets.isEmpty, "a scriptlets file from another build or with a missing body must be rebuilt, not used")
    }
    try saved.write(to: fixture.lists.scriptletsURL)

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
    controller.addUserScript(pageScript)
    let scriptletCount = { controller.userScripts.count { $0.source.contains("trusted-replace-argument") } }
    func navigate(_ nonce: String) async throws -> String? {
      blocker.prepareNavigation(of: controller, toHost: "www.allrecipes.com")
      blocker.countScriptletPage(toHost: "www.allrecipes.com")
      #expect(controller.userScripts.contains { $0 === pageScript })
      return try await ScriptletPages.run(host: "www.allrecipes.com", nonce: nonce, in: webView).load
    }

    #expect(try await navigate("on") == "")
    #expect(counted == [false])
    #expect(scriptletCount() == 1)

    controller.removeAllUserScripts()
    blocker.restoreUserScripts(on: controller)
    controller.addUserScript(pageScript)
    #expect(scriptletCount() == 1)
    #expect(try await navigate("baked") == "")

    settings.setExempt("www.allrecipes.com", true)
    #expect(try await navigate("trusted") == "fetch(url).then(adShieldError)")
    #expect(counted == [false, false])
    #expect(scriptletCount() == 0)

    settings.setExempt("www.allrecipes.com", false)
    #expect(try await navigate("again") == "")
    #expect(counted == [false, false, false])
    #expect(scriptletCount() == 1)

    settings.blocksAds = false
    #expect(try await navigate("off") == "fetch(url).then(adShieldError)")
    #expect(counted == [false, false, false])
    #expect(scriptletCount() == 0)
  }
}
