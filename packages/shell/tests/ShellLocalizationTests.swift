import XCTest
@testable import ArdiaShellLocalization

final class ShellLocalizationTests: XCTestCase {
  func testSimplifiedChineseLanguageTags() {
    for tag in ["zh-Hans", "zh-CN", "zh-SG", "zh", "zh_Hans_CN"] {
      XCTAssertTrue(ShellL10n.usesSimplifiedChinese([tag]), tag)
    }
  }

  func testOtherPreferredLanguagesKeepEnglish() {
    for tag in ["zh-Hant", "zh-TW", "zh-HK", "zh-MO", "zh-Hant-CN", "en-US"] {
      XCTAssertFalse(ShellL10n.usesSimplifiedChinese([tag, "zh-Hans"]), tag)
    }
    XCTAssertFalse(ShellL10n.usesSimplifiedChinese([]))
  }

  func testTranslationAndFallback() {
    let original = ShellL10n.preferredLanguagesOverride
    defer { ShellL10n.preferredLanguagesOverride = original }

    ShellL10n.preferredLanguagesOverride = ["zh-Hans"]
    XCTAssertEqual(ShellL10n.t("Cancel"), "取消")
    XCTAssertEqual(ShellL10n.t("Unlisted text"), "Unlisted text")

    ShellL10n.preferredLanguagesOverride = ["en"]
    XCTAssertEqual(ShellL10n.t("Cancel"), "Cancel")
  }
}
