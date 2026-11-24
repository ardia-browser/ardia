import Foundation
import XCTest
@testable import ArdiaImportCore

final class ArcExtrasTests: XCTestCase {
  private let spaces = ["S-PERSONAL": "Personal", "S-WORK": "Work", "S-UNTITLED": "Space 1"]
  private let refSeconds = Double(1_788_220_800) - 978_307_200

  private func routing() throws -> ArcRouting {
    try ArcExtras.routing(Data(contentsOf: Fixtures.support("Arc/StorableLinkRouting.json")), spaces: spaces)
  }

  private func archive() throws -> ArcArchive {
    try ArcExtras.archive(Data(contentsOf: Fixtures.support("Arc/StorableArchiveItems.json")),
                          threshold: ArcExtras.threshold(preferences: Fixtures.discovery().arcPreferencesURL()), spaces: spaces)
  }

  func testAirTrafficRulesKeepTheirOrderMatchAndDestination() throws {
    let r = try routing()
    XCTAssertEqual(r.rules.map(\.text), ["meet.google.com", "jira.example/browse", "https://www.docs.example/", "calendar.example", "gone.example"])
    XCTAssertEqual(r.rules.map(\.match), [.contains, .contains, .contains, .equals, .contains])
    XCTAssertEqual(r.rules.map(\.to), [
      ArcLinkDestination(kind: .mostRecent),
      ArcLinkDestination(kind: .space, spaceId: "S-WORK", spaceName: "Work"),
      ArcLinkDestination(kind: .littleArc),
      ArcLinkDestination(kind: .littleArc, spaceId: "S-PERSONAL", spaceName: "Personal"),
      ArcLinkDestination(kind: .space, spaceId: "S-DELETED"),
    ])
    XCTAssertTrue(r.rules.allSatisfy { $0.id.hasPrefix("R-") })
    XCTAssertEqual(r.skipped, 4, "a blank text, an unknown operator, two conditions and a profile destination are left out")
    XCTAssertEqual(r.fallback, ArcLinkDestination(kind: .mostRecent))
    XCTAssertTrue(r.changesFallback)
  }

  func testOnlyConditionsAndDestinationsArcWritesAreRead() throws {
    func rule(_ body: String) throws -> ArcRouting {
      try ArcExtras.routing(Data(#"{"rules": [\#(body)]}"#.utf8), spaces: spaces)
    }
    let ok = #"{"id": "R-1", "destination": {"space": {"_0": {"mostRecent": {}}}}, "sourceComponents": [{"componentType": {"urlMatch": {"_0": {"contains": {}}, "_1": "a.example"}}}]}"#
    XCTAssertEqual(try rule(ok).rules.count, 1)
    for bad in [
      ok.replacingOccurrences(of: #""id": "R-1", "#, with: ""),
      ok.replacingOccurrences(of: #"{"contains": {}}"#, with: #"{"contains": {}, "matches": {}}"#),
      ok.replacingOccurrences(of: #"{"mostRecent": {}}"#, with: #"{"mostRecent": {}, "space": {"_0": "S-WORK"}}"#),
      ok.replacingOccurrences(of: #""urlMatch""#, with: #""titleMatch""#),
      ok.replacingOccurrences(of: "a.example", with: String(repeating: "a", count: ArcExtras.maximumText + 1)),
      ok.replacingOccurrences(of: #""space": {"_0""#, with: #""window": {"_0""#),
    ] {
      let r = try rule(bad)
      XCTAssertEqual(r.rules.count, 0, bad)
      XCTAssertEqual(r.skipped, 1, bad)
    }
    let many = Array(repeating: ok, count: ArcExtras.maximumRules + 5).joined(separator: ",")
    let capped = try rule(many)
    XCTAssertEqual(capped.rules.count, ArcExtras.maximumRules)
    XCTAssertEqual(capped.skipped, 5)
  }

  func testFilesAreReadOnlyWhenSmallRegularAndInsideTheirFolder() throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("arc-bounded-\(UUID().uuidString)")
    let arc = root.appendingPathComponent("Arc")
    try fm.createDirectory(at: arc, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: root) }
    try Data("outside".utf8).write(to: root.appendingPathComponent("secret.json"))
    try Data("inside".utf8).write(to: arc.appendingPathComponent("ok.json"))
    try fm.createSymbolicLink(at: arc.appendingPathComponent("link.json"), withDestinationURL: root.appendingPathComponent("secret.json"))
    try fm.createDirectory(at: arc.appendingPathComponent("dir.json"), withIntermediateDirectories: true)
    XCTAssertEqual(ArcExtras.boundedRead(arc.appendingPathComponent("ok.json"), within: arc, limit: 100), Data("inside".utf8))
    XCTAssertNil(ArcExtras.boundedRead(arc.appendingPathComponent("ok.json"), within: arc, limit: 3))
    XCTAssertNil(ArcExtras.boundedRead(arc.appendingPathComponent("link.json"), within: arc, limit: 100))
    XCTAssertNil(ArcExtras.boundedRead(arc.appendingPathComponent("dir.json"), within: arc, limit: 100))
    XCTAssertNil(ArcExtras.boundedRead(arc.appendingPathComponent("../secret.json"), within: arc, limit: 100))
    XCTAssertNil(ArcExtras.boundedRead(arc.appendingPathComponent("missing.json"), within: arc, limit: 100))
  }

  func testLittleArcAsTheDefaultLeavesTheFallbackAlone() throws {
    let json = #"{"rules": [], "defaultDestination": {"littleArc": {"_0": {"mostRecent": {}}}}, "version": 1}"#
    let r = try ArcExtras.routing(Data(json.utf8), spaces: spaces)
    XCTAssertEqual(r.fallback, ArcLinkDestination(kind: .littleArc))
    XCTAssertFalse(r.changesFallback)
    XCTAssertThrowsError(try ArcExtras.routing(Data("[1]".utf8), spaces: spaces))
  }

  func testArchiveKeepsWebTabsNewestFirstWithTheirSpaceAndTheThreshold() throws {
    let a = try archive()
    XCTAssertEqual(a.cleanUpAfterMinutes, 7 * 24 * 60)
    XCTAssertEqual(a.tabs.map(\.url), ["https://ghost.example/", "https://little.example/", "https://report.example/q3", "https://old-news.example/"])
    XCTAssertEqual(a.tabs.map(\.spaceName), [nil, nil, "Work", "Personal"])
    XCTAssertEqual(a.tabs[2].customTitle, "Report")
    XCTAssertEqual(a.tabs[2].title, "Q3 report")
    XCTAssertEqual(a.tabs[3].auto, true)
    XCTAssertEqual(a.tabs[2].archivedAt, (refSeconds - 3600 + 978_307_200) * 1000)
  }

  func testArchiveIsCappedAndAnUnknownThresholdIsIgnored() throws {
    let entries = (0..<(ArcExtras.maximumArchived + 20)).map { i in
      #"{"archivedAt": \#(i), "reason": "manual", "sidebarItem": {"data": {"tab": {"savedURL": "https://e.example/\#(i)"}}}}"#
    }
    let a = try ArcExtras.archive(Data(#"{"items": [\#(entries.joined(separator: ","))]}"#.utf8), threshold: "never", spaces: [:])
    XCTAssertEqual(a.tabs.count, ArcExtras.maximumArchived)
    XCTAssertEqual(a.dropped, 20)
    XCTAssertEqual(a.tabs.first?.url, "https://e.example/\(ArcExtras.maximumArchived + 19)")
    XCTAssertNil(a.cleanUpAfterMinutes)
    XCTAssertEqual(try ArcExtras.archive(nil, threshold: "twelveHours", spaces: [:]).cleanUpAfterMinutes, 720)
  }

  private func scratchArc() throws -> (support: URL, arc: URL, outside: URL) {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("arc-extras-\(UUID().uuidString)")
    let support = root.appendingPathComponent("Library/Application Support")
    let arc = support.appendingPathComponent("Arc")
    try fm.createDirectory(at: support, withIntermediateDirectories: true)
    try fm.copyItem(at: Fixtures.support("Arc"), to: arc)
    let outside = root.appendingPathComponent("outside")
    try fm.createDirectory(at: outside, withIntermediateDirectories: true)
    addTeardownBlock { try? fm.removeItem(at: root) }
    return (support, arc, outside)
  }

  func testTheIconCacheMustSitInsideArc() throws {
    let fm = FileManager.default
    let (_, arc, outside) = try scratchArc()
    let cache = arc.appendingPathComponent(ArcExtras.iconCacheFolder)
    let items = ["https://calendar.example/": "T-1"]
    XCTAssertEqual(ArcExtras.cachedFavicons(folder: cache, root: arc, items: items, pages: Array(items.keys), known: []).count, 1)
    try fm.moveItem(at: cache, to: outside.appendingPathComponent("cache"))
    try fm.createSymbolicLink(at: cache, withDestinationURL: outside.appendingPathComponent("cache"))
    XCTAssertEqual(ArcExtras.cachedFavicons(folder: cache, root: arc, items: items, pages: Array(items.keys), known: []), [])
  }

  func testExtrasAreOfferedWithoutSpacesAndForRulesThatAllStayBehind() throws {
    let fm = FileManager.default
    let (support, arc, outside) = try scratchArc()
    try fm.moveItem(at: arc.appendingPathComponent("StorableSidebar.json"), to: outside.appendingPathComponent("StorableSidebar.json"))
    try fm.createSymbolicLink(at: arc.appendingPathComponent("StorableSidebar.json"), withDestinationURL: outside.appendingPathComponent("StorableSidebar.json"))
    let skippedOnly = #"{"rules": [{"id": "R-1", "destination": {"window": {}}, "sourceComponents": []}], "defaultDestination": {"littleArc": {"_0": {"mostRecent": {}}}}}"#
    try Data(skippedOnly.utf8).write(to: arc.appendingPathComponent(ArcExtras.routingFile))
    let discovery = BrowserDiscovery(applicationSupport: support, locateApp: { ids in ids.contains("company.thebrowser.Browser") ? URL(fileURLWithPath: "/Applications/Arc.app") : nil })
    let source = try XCTUnwrap(discovery.list().first { $0.id == "arc" })
    let personal = try XCTUnwrap(source.profiles.first { $0.id == "Default" })
    XCTAssertEqual(personal.spaces ?? [], [], "a sidebar file that links out of Arc isn't read")
    XCTAssertTrue(personal.available.contains(.linkRules))
    XCTAssertTrue(personal.available.contains(.archive))
    XCTAssertFalse(personal.available.contains(.spaces))
    let result = try Importer(discovery: discovery).importData(browserId: "arc", profileId: "Default", kinds: [.linkRules])
    XCTAssertEqual(result.arcRouting?.rules, [])
    XCTAssertEqual(result.arcRouting?.skipped, 1)
  }

  func testAnUnreadableArchiveFailsAndAMissingOneKeepsTheTiming() throws {
    let fm = FileManager.default
    let (support, arc, outside) = try scratchArc()
    let file = arc.appendingPathComponent(ArcExtras.archiveFile)
    try fm.moveItem(at: file, to: outside.appendingPathComponent(ArcExtras.archiveFile))
    try fm.createSymbolicLink(at: file, withDestinationURL: outside.appendingPathComponent(ArcExtras.archiveFile))
    let discovery = BrowserDiscovery(applicationSupport: support)
    let unreadable = try Importer(discovery: discovery).importData(browserId: "arc", profileId: "Default", kinds: [.archive])
    XCTAssertEqual(unreadable.failed, [.archive])
    XCTAssertNil(unreadable.arcArchive)
    try fm.removeItem(at: file)
    let missing = try Importer(discovery: discovery).importData(browserId: "arc", profileId: "Default", kinds: [.archive])
    XCTAssertEqual(missing.failed, [])
    XCTAssertEqual(missing.arcArchive?.tabs, [])
  }

  func testIconFilesAreNamedByTheMD5OfTheItemId() {
    XCTAssertEqual(ArcExtras.iconFileName(itemId: "T-1"), "b0c453d8de3950e1c5097f75ea6c5502")
    XCTAssertEqual(ArcExtras.iconFileName(itemId: ""), "d41d8cd98f00b204e9800998ecf8427e")
  }

  func testArcsOwnSidebarIconsComeFirstAndChromiumsFillTheRest() throws {
    let importer = Importer(discovery: Fixtures.discovery())
    let result = try importer.importData(browserId: "arc", profileId: "Default", kinds: [.spaces, .pinnedTabs, .tabs, .favorites])
    let byPage = Dictionary(result.favicons.map { ($0.page, $0) }, uniquingKeysWith: { first, _ in first })
    let arcPNG = try Data(contentsOf: Fixtures.support("Arc/SidebarItemsFaviconCache/\(ArcExtras.iconFileName(itemId: "T-1"))"))
    XCTAssertEqual(byPage["https://calendar.example/"]?.png, arcPNG.base64EncodedString())
    XCTAssertEqual(byPage["https://calendar.example/"]?.icon, "https://calendar.example/icon.png")
    XCTAssertEqual(byPage["https://today.example/"]?.icon, "https://today.example/favicon.ico")
    XCTAssertEqual(byPage["https://mail.example.com/"]?.png, arcPNG.base64EncodedString())
    XCTAssertNotEqual(byPage["https://blog.example/post"]?.png, arcPNG.base64EncodedString())
    XCTAssertNotNil(byPage["https://blog.example/post"])
    XCTAssertEqual(result.arcCachedIcons, 3)
    XCTAssertEqual(Set(result.favicons.map(\.page)).count, result.favicons.count)
  }

  func testTheExtrasAreOfferedAndImportedForArc() throws {
    let discovery = Fixtures.discovery()
    let arc = try XCTUnwrap(discovery.list().first { $0.id == "arc" })
    let personal = try XCTUnwrap(arc.profiles.first { $0.id == "Default" })
    XCTAssertTrue(personal.available.contains(.linkRules))
    XCTAssertTrue(personal.available.contains(.archive))
    let result = try Importer(discovery: discovery).importData(browserId: "arc", profileId: "Default", kinds: [.linkRules, .archive])
    XCTAssertEqual(result.arcRouting?.rules.count, 5)
    XCTAssertEqual(result.arcRouting?.skipped, 4)
    XCTAssertEqual(result.arcArchive?.tabs.count, 4)
    XCTAssertEqual(result.arcArchive?.cleanUpAfterMinutes, 7 * 24 * 60)
    XCTAssertEqual(result.failed, [])
    let json = String(decoding: try JSONEncoder().encode(result), as: UTF8.self)
    XCTAssertTrue(json.contains(#""arcRouting""#) && json.contains(#""arcArchive""#))
  }
}
