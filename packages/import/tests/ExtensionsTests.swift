import XCTest
@testable import ArdiaImportCore

final class ExtensionsTests: XCTestCase {
  func testListsWebStoreExtensionsWithNames() {
    let list = ChromiumExtensions.list(profile: Fixtures.url("extensions/Default")).filter { $0.skip == nil }
    XCTAssertEqual(list.map(\.name), ["Localized Blocker", "Older Chrome Keeps Manifests", "Plain Name"])
    XCTAssertEqual(list.map(\.id), ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"])
    XCTAssertEqual(list.first?.webStoreUrl, "https://chromewebstore.google.com/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    XCTAssertTrue(list.allSatisfy { $0.enabled && $0.pinnedIndex == nil })
  }

  func testListsUnpackedExtensionsAsNotInstallableAndHidesComponents() {
    let list = ChromiumExtensions.list(profile: Fixtures.url("extensions/Default"))
    XCTAssertEqual(list.filter { $0.skip != nil }.map(\.id), ["cccccccccccccccccccccccccccccccc"])
    XCTAssertEqual(list.first { $0.id == "cccccccccccccccccccccccccccccccc" }?.skip, .unpacked)
    XCTAssertFalse(list.contains { $0.id == "dddddddddddddddddddddddddddddddd" })
  }

  func testHeliumListsStoreInstallsButNotItsBuiltInUBlock() {
    let list = ChromiumExtensions.list(profile: Fixtures.url("extensions/Helium"))
    XCTAssertEqual(list.map(\.id), ["eimadpbcbfnmbkopoojfekhnkhdbieeh"])
    XCTAssertEqual(list.map(\.name), ["Dark Reader"])
    XCTAssertEqual(list.first?.skip, nil)
  }

  func testLeavesOutUBlockOriginAndItsLiteVersion() {
    XCTAssertEqual(ChromiumExtensions.list(profile: Fixtures.url("extensions/UBlockOnly")), [])
  }

  func testMissingProfileListsNothing() {
    XCTAssertEqual(ChromiumExtensions.list(profile: Fixtures.url("extensions/Nope")), [])
  }

  func testSaysWhyEachExtensionCantComeFromTheWebStore() {
    let list = ChromiumExtensions.list(profile: Fixtures.url("extensions/Mixed"))
    let byName = Dictionary(uniqueKeysWithValues: list.map { ($0.name, $0) })
    XCTAssertEqual(byName["Clip Saver"]?.skip, nil)
    XCTAssertEqual(byName["Tab Notes"]?.skip, nil)
    XCTAssertEqual(byName["Old Toolbar"]?.skip, .manifestV2)
    XCTAssertEqual(byName["Flagged By Chrome"]?.skip, .manifestV2)
    XCTAssertEqual(byName["Dev Helper"]?.skip, .unpacked)
    XCTAssertEqual(byName["Company SSO"]?.skip, .policy)
    XCTAssertEqual(byName["Password Helper"]?.skip, .external)
    XCTAssertEqual(byName["Dragged In"]?.skip, .notWebStore)
    XCTAssertEqual(byName["No Location"]?.skip, .notWebStore)
    XCTAssertNil(byName["A Theme"])
    XCTAssertNil(byName["Built In"])
  }

  func testReadsOnOffStateFromChromiumsDisableReasonsAndToolbarPins() {
    let list = ChromiumExtensions.list(profile: Fixtures.url("extensions/Mixed"))
    let byName = Dictionary(uniqueKeysWithValues: list.map { ($0.name, $0) })
    XCTAssertEqual(byName["Clip Saver"]?.enabled, true, "a permissions increase (1 << 1) alone isn't the user turning it off")
    XCTAssertEqual(byName["Tab Notes"]?.enabled, false, "the list form holds DISABLE_USER_ACTION")
    XCTAssertEqual(byName["Old Off"]?.enabled, false, "an old Chrome's state 0")
    XCTAssertEqual(byName["Legacy Mask Off"]?.enabled, false, "the legacy bitmask 3 holds DISABLE_USER_ACTION")
    XCTAssertEqual(byName["Reloading"]?.enabled, true, "DISABLE_RELOAD (1 << 2) isn't the user turning it off")
    XCTAssertEqual(byName["Tab Notes"]?.pinnedIndex, 0)
    XCTAssertEqual(byName["Clip Saver"]?.pinnedIndex, 1)
    XCTAssertNil(byName["Old Off"]?.pinnedIndex)
  }

  func testDecodesBothFormsOfDisableReasons() {
    XCTAssertEqual(ChromiumExtensions.disableReasons(["disable_reasons": [2, 8388608]]), [1 << 1, 1 << 23])
    XCTAssertEqual(ChromiumExtensions.disableReasons(["disable_reasons": 6]), [1 << 1, 1 << 2])
    XCTAssertEqual(ChromiumExtensions.disableReasons(["disable_reasons": 0, "state": 1]), [])
    XCTAssertEqual(ChromiumExtensions.disableReasons(["state": 0]), [1 << 0])
  }

  func testOnlyJSONIntegersAndBooleansCountAsTheWebStore() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let settings = """
    {"extensions": {"settings": {
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {"from_webstore": true, "location": 1, "manifest": {"name": "Real"}},
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": {"from_webstore": 1, "location": 1, "manifest": {"name": "Number For Bool"}},
      "cccccccccccccccccccccccccccccccc": {"from_webstore": true, "location": true, "manifest": {"name": "Bool For Number"}},
      "dddddddddddddddddddddddddddddddd": {"from_webstore": true, "location": "1", "manifest": {"name": "String Location"}},
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": {"from_webstore": true, "location": 1.5, "manifest": {"name": "Fraction Location"}},
      "ffffffffffffffffffffffffffffffff": {"from_webstore": "true", "location": 1, "manifest": {"name": "String Bool"}},
      "gggggggggggggggggggggggggggggggg": {"from_webstore": true, "location": 1, "disable_reasons": [true], "manifest": {"name": "Bool Reason"}},
      "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {"from_webstore": true, "location": 1, "manifest": {"name": "Bad Id"}}
    }}}
    """
    try Data(settings.utf8).write(to: dir.appendingPathComponent("Preferences"))
    let byName = Dictionary(uniqueKeysWithValues: ChromiumExtensions.list(profile: dir).map { ($0.name, $0) })
    XCTAssertEqual(byName["Real"]?.skip, nil)
    for name in ["Number For Bool", "Bool For Number", "String Location", "Fraction Location", "String Bool"] {
      XCTAssertEqual(byName[name]?.skip, .notWebStore, name)
    }
    XCTAssertEqual(byName["Bool Reason"]?.enabled, true)
    XCTAssertNil(byName["Bad Id"])
  }

  func testEncodesLeftOutFieldsAsAbsent() throws {
    let list = ChromiumExtensions.list(profile: Fixtures.url("extensions/Mixed"))
    let data = try JSONEncoder().encode(list.first { $0.name == "Old Off" })
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertNil(json["skip"])
    XCTAssertNil(json["pinnedIndex"])
    XCTAssertEqual(json["enabled"] as? Bool, false)
  }

  func testChromeFixtureProfilesCarryTheirOwnExtensions() {
    let personal = ChromiumExtensions.list(profile: Fixtures.support("Google/Chrome/Default"))
    XCTAssertEqual(personal.filter { $0.skip == nil }.map(\.name), ["Clip Saver", "Tab Notes"])
    XCTAssertEqual(personal.compactMap(\.skip).sorted { $0.rawValue < $1.rawValue }, [.manifestV2, .policy, .unpacked])
    let work = ChromiumExtensions.list(profile: Fixtures.support("Google/Chrome/Profile 1"))
    XCTAssertEqual(work.map(\.name), ["Clip Saver", "Focus Timer", "Read Later"])
    XCTAssertEqual(work.map(\.pinnedIndex), [1, 0, nil])
  }
}
