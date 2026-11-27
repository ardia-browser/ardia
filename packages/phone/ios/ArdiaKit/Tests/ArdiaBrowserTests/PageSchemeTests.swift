import Foundation
import Testing
@testable import ArdiaBrowser

@MainActor
struct PageSchemeTests {
  @Test func theChosenSchemeIsKeptAndAChangeIsAnnounced() {
    let suite = "ardia.pagescheme.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let preferences = BrowsingPreferences(defaults: defaults)
    #expect(preferences.pageScheme == nil)
    var announced = 0
    preferences.onPageSchemeChange = { announced += 1 }
    preferences.pageScheme = .dark
    preferences.pageScheme = .dark
    #expect(announced == 1)
    #expect(BrowsingPreferences(defaults: defaults).pageScheme == .dark)
    preferences.pageScheme = nil
    #expect(announced == 2)
    #expect(BrowsingPreferences(defaults: defaults).pageScheme == nil)
  }
}

#if canImport(UIKit)
import UIKit
import WebKit

@MainActor
@Suite(.serialized) struct PageSchemeEngineTests {
  static let darkProbe = """
    <!doctype html><html><head><meta name="color-scheme" content="light dark"></head>
    <body><script>window.__nonce = "scheme"</script></body></html>
    """

  static func prefersDark(_ webView: WKWebView?) async throws -> Bool? {
    try await webView?.evaluateJavaScript("matchMedia('(prefers-color-scheme: dark)').matches") as? Bool
  }

  @Test func aPageKeepsTheChosenSchemeInsideALightWindowAndFollowsAChange() async throws {
    let fixture = try NightShadeEngineFixture()
    defer { fixture.cleanUp() }
    fixture.engine.preferences.pageScheme = .dark
    let page = try fixture.liveTab()
    let webView = try #require(page.webView)
    #expect(webView.overrideUserInterfaceStyle == .dark)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    window.overrideUserInterfaceStyle = .light
    window.addSubview(webView)
    window.isHidden = false
    defer { window.isHidden = true }
    try await NightShadePages.load(Self.darkProbe, host: "scheme.example", nonce: "scheme", into: try #require(page.webView))
    #expect(try await Self.prefersDark(page.webView) == true)

    fixture.engine.preferences.pageScheme = .light
    #expect(page.webView?.overrideUserInterfaceStyle == .light)
    try await NightShadePages.waitUntil("the page to see light") { (try? await Self.prefersDark(page.webView)) == false }
  }
}
#endif
