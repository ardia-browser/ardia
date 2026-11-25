import Foundation
import XCTest
@testable import ArdiaImportCore

final class SearchEngineTests: XCTestCase {
  let importer = Importer(discovery: Fixtures.discovery())

  func engine(_ browserId: String, _ profileId: String) throws -> ImportedSearchEngine? {
    try importer.importData(browserId: browserId, profileId: profileId, kinds: [.bookmarks]).searchEngine
  }

  func testArcProfileOnDuckDuckGoBringsItsKeywordRow() throws {
    XCTAssertEqual(try engine("arc", "Default"), ImportedSearchEngine(name: "DuckDuckGo", keyword: "duckduckgo.com",
                                                                     url: "https://duckduckgo.com/?q={searchTerms}", prepopulateId: 92))
  }

  func testProfileOnTheBrowsersOwnDefaultBringsNothing() throws {
    XCTAssertNil(try engine("arc", "Profile 1"))
  }

  func testCustomEngineKeepsItsTemplate() throws {
    let engine = try XCTUnwrap(try engine("chrome", "Default"))
    XCTAssertEqual(engine.url, "https://docs.ardia.example/find?q={searchTerms}&enc={inputEncoding}&{google:RLZ}")
    XCTAssertNil(engine.prepopulateId)
  }

  func testUnreadablePreferencesBringNothing() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-search-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    XCTAssertNil(ChromiumSearchEngine.read(profile: dir))
    try Data("{not json".utf8).write(to: dir.appendingPathComponent("Preferences"))
    XCTAssertNil(ChromiumSearchEngine.read(profile: dir))
  }
}
