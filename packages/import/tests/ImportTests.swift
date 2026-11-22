import Foundation
import XCTest
@testable import ArdiaImportCore

final class ImportTests: XCTestCase {
  let chrome = Fixtures.support("Google/Chrome/Default")

  func testBookmarksHtmlMarksUnnamedListsAndKeepsEmptyNamedFolders() {
    let html = """
    <DL><p>
        <DT><H3 ADD_DATE="1700000000"></H3>
        <DL><p>
        </DL><p>
        <DT><H3 ADD_DATE="0"></H3>
        <DL><p>
            <DT><A HREF="https://kept.example/">Kept</A>
        </DL><p>
        <DT><H3></H3>
        <DL><p>
        </DL><p>
        <DL><p>
            <DT><A HREF="https://loose.example/">Loose</A>
        </DL><p>
    </DL><p>
    """
    let children = NetscapeBookmarks.parse(html).children ?? []
    XCTAssertEqual(children.map(\.title), ["", "", "", ""])
    XCTAssertEqual(children.map(\.role), [nil, nil, nil, "list"])
    XCTAssertEqual(children.map { $0.children?.count }, [0, 1, 0, 1])
    XCTAssertEqual(children[0].dateAdded, 1_700_000_000_000)
  }

  func testHistoryLeavesSourceUntouched() throws {
    let file = chrome.appendingPathComponent("History")
    let before = try Data(contentsOf: file)
    _ = try HistoryReader.read(file, flavor: .chromium)
    XCTAssertEqual(try Data(contentsOf: file), before)
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path + "-journal"))
  }

  func testDecryptRejectsWrongKeyAndPassesLegacyPlaintext() {
    let wrong = ChromiumCrypto.deriveKey(secret: Data("nope".utf8))
    XCTAssertNil(ChromiumCrypto.decrypt(Data("v10".utf8) + Data(repeating: 1, count: 16), key: wrong))
    XCTAssertEqual(ChromiumCrypto.decrypt(Data("plain".utf8), key: wrong), "plain")
  }

  func testLoginsDecryptAndDedupeAcrossAccountStore() throws {
    let outcome = try ChromiumSecrets.logins(profile: chrome, key: Fixtures.chromiumKey)
    let pairs = outcome.items.map { "\($0.username)@\($0.url)=\($0.password)" }
    XCTAssertEqual(pairs, [
      "alex@example.com@https://accounts.example.com/login=correct horse",
      "alex@https://shop.example/=pässwörd 🔑",
      "alex@android://hash@com.example.app/=from-android",
      "old@https://legacy.example/=plain-legacy",
      "sam@https://account-only.example/=only-in-account",
    ])
    XCTAssertEqual(outcome.undecryptable, 1)
    let first = outcome.items[0]
    XCTAssertEqual(first.realm, "https://accounts.example.com/")
    XCTAssertEqual(first.timesUsed, 12)
    XCTAssertEqual(first.lastUsed, Double(1788220800 - 3600) * 1000)
    XCTAssertEqual(first.created, Double(1788220800 - 86400 * 30) * 1000)
  }

  func testProfileIdCannotEscapeDataDirectory() throws {
    let d = Fixtures.discovery()
    let chrome = BrowserDefinition.find("chrome")!
    XCTAssertNoThrow(try d.profileDirectory(chrome, "Profile 1"))
    XCTAssertThrowsError(try d.profileDirectory(chrome, "../../Firefox"))
    XCTAssertThrowsError(try d.profileDirectory(chrome, "../Chrome Beta"))
    XCTAssertThrowsError(try d.profileDirectory(chrome, "Nope"))
  }

  func testFirefoxNeedsConsentForPasswordsNotCookies() throws {
    let importer = Importer(discovery: Fixtures.discovery())
    let id = "Profiles/abcd1234.default-release"
    let locked = try importer.importData(browserId: "firefox", profileId: id, kinds: [.bookmarks, .history, .tabs, .passwords, .cookies])
    XCTAssertEqual(locked.failed, [.passwords])
    XCTAssertEqual(locked.bookmarks?.linkCount, 4)
    XCTAssertEqual(locked.historyCount, 4)
    XCTAssertEqual(locked.tabs.count, 3)
    XCTAssertEqual(locked.cookieCount, 6)
    XCTAssertTrue(locked.warnings.contains { $0.kind == .cookies && $0.code == .skipped })

    try importer.unlock(browserId: "firefox")
    let open = try importer.importData(browserId: "firefox", profileId: id, kinds: [.passwords])
    XCTAssertEqual(open.failed, [])
    XCTAssertEqual(open.credentials.count, 2)

    let work = try importer.importData(browserId: "firefox", profileId: "Profiles/zzzz9999.work", kinds: [.passwords])
    XCTAssertEqual(work.failed, [.passwords])
    XCTAssertEqual(work.warnings.first?.code, .locked)
    try importer.unlock(browserId: "firefox", primaryPassword: "hunter2")
    XCTAssertEqual(try importer.importData(browserId: "firefox", profileId: "Profiles/zzzz9999.work", kinds: [.passwords])
      .credentials.map(\.password), ["aes-protected"])
  }
}
