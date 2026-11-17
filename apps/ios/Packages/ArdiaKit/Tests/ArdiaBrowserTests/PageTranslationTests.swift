import Foundation
import Testing
@testable import ArdiaBrowser

@MainActor
struct PageTranslationTests {
  @Test func startURLCarriesTheChosenLanguage() throws {
    let url = try #require(PageTranslation.url(translating: URL(string: "https://example.com/a?b=1")!, into: "fr"))
    #expect(url.host() == "translate.google.com")
    #expect(PageTranslation.chosenLanguage(in: url) == "fr")
  }

  @Test func readsTheLanguagePickedOnGooglesPage() {
    let picked = URL(string: "https://example-com.translate.goog/a?b=1&_x_tr_sl=auto&_x_tr_tl=de&_x_tr_hl=en&_x_tr_pto=wapp")!
    #expect(PageTranslation.chosenLanguage(in: picked) == "de")
    #expect(PageTranslation.chosenLanguage(in: URL(string: "https://example-com.translate.goog/?_x_tr_tl=zh-TW")!) == "zh-TW")
  }

  @Test func ignoresPagesThatAreNotATranslation() {
    #expect(PageTranslation.chosenLanguage(in: URL(string: "https://example.com/?tl=fr&_x_tr_tl=fr")!) == nil)
    #expect(PageTranslation.chosenLanguage(in: URL(string: "https://translate.google.com/?tl=fr")!) == nil)
    #expect(PageTranslation.chosenLanguage(in: URL(string: "https://example-com.translate.goog/?_x_tr_tl=auto")!) == nil)
    #expect(PageTranslation.chosenLanguage(in: URL(string: "https://example-com.translate.goog/?_x_tr_tl=%3Cscript%3E")!) == nil)
  }

  @Test func systemLanguageKeepsChineseScripts() {
    #expect(PageTranslation.systemLanguage(preferred: ["en-US"]) == "en")
    #expect(PageTranslation.systemLanguage(preferred: ["zh-Hant-TW"]) == "zh-TW")
    #expect(PageTranslation.systemLanguage(preferred: ["zh-Hans-CN"]) == "zh-CN")
    #expect(PageTranslation.systemLanguage(preferred: []) == "en")
  }

  @Test func preferencesRememberTheLastLanguageAndTheConsent() {
    let defaults = UserDefaults(suiteName: "PageTranslationTests")!
    defaults.removePersistentDomain(forName: "PageTranslationTests")
    let first = BrowsingPreferences(defaults: defaults)
    #expect(first.translateLanguage == nil)
    #expect(!first.translateConfirmed)
    first.rememberTranslation(into: "ja")
    first.translateConfirmed = true
    let relaunched = BrowsingPreferences(defaults: defaults)
    #expect(relaunched.translationTarget == "ja")
    #expect(relaunched.translateConfirmed)
    defaults.removePersistentDomain(forName: "PageTranslationTests")
  }
}
