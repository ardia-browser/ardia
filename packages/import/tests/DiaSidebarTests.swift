import Foundation
import SQLite3
import XCTest
@testable import ArdiaImportCore

final class DiaSidebarTests: XCTestCase {
  let profile = Fixtures.support("Dia/User Data/Default")
  var file: URL { profile.appendingPathComponent("tabs.db") }
  var key: Data { DiaDatabase.key(rootKey: Fixtures.chromiumKey, label: "profile/Default/tabs") }

  func sidebar() throws -> DiaSidebar {
    try DiaSidebar.load(profile: profile, folder: "Default", rootKey: Fixtures.chromiumKey)
  }

  func titles(_ nodes: [BookmarkNode]) -> [String] {
    nodes.map { $0.type == .url ? $0.title : "\($0.role == "split" ? "split" : $0.title)[\(titles($0.children ?? []).joined(separator: ","))]" }
  }

  func testTheRightKeyOpensAPlainSQLiteDatabase() throws {
    let plain = try DiaDatabase.decrypt(file, key: key)
    XCTAssertEqual(String(decoding: plain.prefix(15), as: UTF8.self), "SQLite format 3")
    XCTAssertEqual(Array(plain[16...23]), [0x10, 0x00, 1, 1, 80, 64, 32, 32])
    XCTAssertEqual(plain.count % DiaDatabase.pageSize, 0)
  }

  func testAWrongKeyOrAnotherProfilesLabelDoesNotOpen() {
    let wrongRoot = ChromiumCrypto.deriveKey(secret: Data("some-other-secret".utf8))
    for wrong in [DiaDatabase.key(rootKey: wrongRoot, label: "profile/Default/tabs"),
                  DiaDatabase.key(rootKey: Fixtures.chromiumKey, label: "profile/Profile 2/tabs")] {
      XCTAssertThrowsError(try DiaDatabase.decrypt(file, key: wrong)) {
        XCTAssertEqual(($0 as? ImportError)?.code, "unreadable")
      }
    }
  }

  func testCommittedWALFramesAreFoldedInAndAnUnfinishedTransactionIsNot() throws {
    let urls = try sidebar().spaces.flatMap { ($0.openGroups ?? []).flatMap(links) + $0.tabs.map(\.url) }
    XCTAssertTrue(urls.contains("https://later.dia.example/"))
    XCTAssertFalse(urls.contains("https://uncommitted.dia.example/"))
  }

  func testWithoutItsWALTheFileReadsAsItWasBeforeTheEdit() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-dia-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.copyItem(at: file, to: dir.appendingPathComponent("tabs.db"))
    let spaces = try DiaSidebar.load(profile: dir, folder: "Default", rootKey: Fixtures.chromiumKey).spaces
    XCTAssertEqual(spaces.first.map { titles($0.openGroups ?? []) }, ["Research[Paper,Sources[Primary source]]"])
  }

  func testATornWALFrameEndsTheFoldAtTheLastGoodCommit() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-dia-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.copyItem(at: file, to: dir.appendingPathComponent("tabs.db"))
    var wal = try Data(contentsOf: URL(fileURLWithPath: file.path + "-wal"))
    wal[32 + 24 + 100] ^= 0xFF
    try wal.write(to: dir.appendingPathComponent("tabs.db-wal"))
    let spaces = try DiaSidebar.load(profile: dir, folder: "Default", rootKey: Fixtures.chromiumKey).spaces
    XCTAssertEqual(spaces.first.map { titles($0.openGroups ?? []) }, ["Research[Paper,Sources[Primary source]]"])
  }

  func scratch(wal: Bool) throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-dia-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.copyItem(at: file, to: dir.appendingPathComponent("tabs.db"))
    if wal { try FileManager.default.copyItem(at: URL(fileURLWithPath: file.path + "-wal"), to: dir.appendingPathComponent("tabs.db-wal")) }
    return dir
  }

  static func put(_ value: UInt32, _ b: inout [UInt8], _ at: Int) {
    for i in 0..<4 { b[at + i] = UInt8(truncatingIfNeeded: value >> (24 - 8 * UInt32(i))) }
  }

  static func resummed(_ wal: [UInt8]) -> [UInt8] {
    var b = wal
    let frame = 24 + DiaDatabase.pageSize
    let bigEndian = DiaDatabase.word(b, 0, bigEndian: true) & 1 == 1
    var sum = DiaDatabase.checksum(b, 0..<24, bigEndian: bigEndian, from: (0, 0))
    var at = 32
    while at + frame <= b.count {
      sum = DiaDatabase.checksum(b, at..<at + 8, bigEndian: bigEndian, from: sum)
      sum = DiaDatabase.checksum(b, at + 24..<at + frame, bigEndian: bigEndian, from: sum)
      put(sum.0, &b, at + 16)
      put(sum.1, &b, at + 20)
      at += frame
    }
    return b
  }

  func editedWAL(in dir: URL, _ edit: (inout [UInt8], _ commitFrame: Int) -> Void) throws {
    var wal = try [UInt8](Data(contentsOf: URL(fileURLWithPath: file.path + "-wal")))
    let frame = 24 + DiaDatabase.pageSize
    let commit = try XCTUnwrap(stride(from: 32, to: wal.count, by: frame).first { DiaDatabase.word(wal, $0 + 4, bigEndian: true) > 0 })
    edit(&wal, commit)
    try Data(Self.resummed(wal)).write(to: dir.appendingPathComponent("tabs.db-wal"))
  }

  func testTheInMemorySnapshotKeepsItsTempTablesInMemory() throws {
    let db = try SQLiteSnapshot(memory: try DiaDatabase.decrypt(file, key: key), name: "tabs.db")
    XCTAssertEqual(try db.scalar("PRAGMA temp_store"), 2)
  }

  func testAPageWithABadHMACDoesNotRead() throws {
    let dir = try scratch(wal: false)
    let copy = dir.appendingPathComponent("tabs.db")
    var main = try Data(contentsOf: copy)
    main[2 * DiaDatabase.pageSize - 1] ^= 0x01
    try main.write(to: copy)
    XCTAssertThrowsError(try DiaDatabase.decrypt(copy, key: key)) { XCTAssertEqual(($0 as? ImportError)?.code, "unreadable") }
  }

  func testAWALFrameWithABadHMACDoesNotRead() throws {
    let dir = try scratch(wal: false)
    try editedWAL(in: dir) { wal, _ in wal[32 + 24 + DiaDatabase.pageSize - 1] ^= 0x01 }
    XCTAssertThrowsError(try DiaDatabase.decrypt(dir.appendingPathComponent("tabs.db"), key: key)) {
      XCTAssertEqual(($0 as? ImportError)?.code, "unreadable")
    }
  }

  func testAWALCommitClaimingAHugeDatabaseIsRejectedBeforeAllocating() throws {
    let dir = try scratch(wal: false)
    try editedWAL(in: dir) { wal, commit in Self.put(UInt32.max, &wal, commit + 4) }
    XCTAssertThrowsError(try DiaDatabase.decrypt(dir.appendingPathComponent("tabs.db"), key: key)) {
      guard case .unreadable(let message) = $0 as? ImportError else { return XCTFail("\($0)") }
      XCTAssertEqual(message, "tabs.db is too large")
    }
  }

  func testAnUnreadableWALFailsTheReadInsteadOfBeingSkipped() throws {
    let dir = try scratch(wal: false)
    try FileManager.default.createDirectory(at: dir.appendingPathComponent("tabs.db-wal"), withIntermediateDirectories: false)
    XCTAssertThrowsError(try DiaDatabase.decrypt(dir.appendingPathComponent("tabs.db"), key: key))
  }

  func testReadsStopAtTheLimitEvenWhenTheFileKeepsGoing() throws {
    let dir = try scratch(wal: false)
    try FileManager.default.createSymbolicLink(atPath: dir.appendingPathComponent("tabs.db-wal").path, withDestinationPath: "/dev/zero")
    XCTAssertThrowsError(try DiaDatabase.decrypt(dir.appendingPathComponent("tabs.db"), key: key, limit: 1 << 20)) {
      guard case .unreadable(let message) = $0 as? ImportError else { return XCTFail("\($0)") }
      XCTAssertEqual(message, "tabs.db-wal is too large")
    }
  }

  func encrypted(_ plain: [UInt8], salt: ArraySlice<UInt8>) throws -> Data {
    let hmacKey = try XCTUnwrap(DiaDatabase.hmacKey(key: key, salt: salt))
    var out = Data()
    for n in 1...(plain.count / DiaDatabase.pageSize) {
      let page = plain[(n - 1) * DiaDatabase.pageSize..<n * DiaDatabase.pageSize]
      let start = page.startIndex + (n == 1 ? DiaDatabase.saltSize : 0)
      let end = page.startIndex + DiaDatabase.pageSize - DiaDatabase.reserved
      let iv = Data((0..<DiaDatabase.ivSize).map { _ in UInt8.random(in: 0...255) })
      let body = try XCTUnwrap(AES.cbc(.encrypt, Data(page[start..<end]), key: key, iv: iv, padding: false))
      var cipher = (n == 1 ? Array(salt) : []) + [UInt8](body) + [UInt8](iv) + [UInt8](repeating: 0, count: DiaDatabase.hmacSize)
      let tag = DiaDatabase.pageTag(cipher[...], number: n, hmacKey: hmacKey)
      cipher.replaceSubrange((DiaDatabase.pageSize - DiaDatabase.hmacSize)..., with: Array(tag))
      out += cipher
    }
    return out
  }

  func checkpointed() throws -> Data {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-dia-\(UUID().uuidString).db").path
    defer { try? FileManager.default.removeItem(atPath: path) }
    try DiaDatabase.decrypt(file, key: key).write(to: URL(fileURLWithPath: path))
    var db: OpaquePointer?
    XCTAssertEqual(sqlite3_open(path, &db), SQLITE_OK)
    XCTAssertEqual(sqlite3_exec(db, "UPDATE web_contents SET url = 'https://checkpointed.dia.example/' WHERE url = 'https://later.dia.example/'", nil, nil, nil), SQLITE_OK)
    sqlite3_close(db)
    let main = try [UInt8](Data(contentsOf: file))
    return try encrypted(try [UInt8](Data(contentsOf: URL(fileURLWithPath: path))), salt: main[0..<DiaDatabase.saltSize])
  }

  func testACheckpointBetweenTheReadsIsReadAgainInsteadOfReplayingStaleFrames() throws {
    let dir = try scratch(wal: true)
    let newer = try checkpointed()
    var checkpoints = 0
    let plain = try DiaDatabase.decrypt(dir.appendingPathComponent("tabs.db"), key: key) {
      guard checkpoints == 0 else { return }
      checkpoints += 1
      try newer.write(to: dir.appendingPathComponent("tabs.db"))
      try FileManager.default.removeItem(at: dir.appendingPathComponent("tabs.db-wal"))
    }
    let spaces = try DiaSidebar.read(try SQLiteSnapshot(memory: plain, name: "tabs.db"), profileId: "Default").spaces
    let urls = spaces.flatMap { ($0.openGroups ?? []).flatMap(links) }
    XCTAssertTrue(urls.contains("https://checkpointed.dia.example/"))
    XCTAssertFalse(urls.contains("https://later.dia.example/"))
  }

  func testARewriteThatKeepsTheSizeAndModifiedTimeIsStillNoticed() throws {
    let dir = try scratch(wal: true)
    let main = dir.appendingPathComponent("tabs.db")
    var before = stat()
    XCTAssertEqual(stat(main.path, &before), 0)
    let bytes = try Data(contentsOf: main)
    var reads = 0
    _ = try DiaDatabase.decrypt(main, key: key) {
      reads += 1
      guard reads == 1 else { return }
      let handle = try FileHandle(forWritingTo: main)
      try handle.seek(toOffset: UInt64(2 * DiaDatabase.pageSize))
      try handle.write(contentsOf: bytes[2 * DiaDatabase.pageSize..<3 * DiaDatabase.pageSize])
      let times = [before.st_atimespec, before.st_mtimespec]
      XCTAssertEqual(futimens(handle.fileDescriptor, times), 0)
      try handle.close()
    }
    XCTAssertEqual(reads, 2)
  }

  func testTheResultSaysWhetherTheSidebarFileWasReadAndNamesItsFirstSpace() throws {
    let importer = Importer(discovery: Fixtures.discovery())
    importer.setKey(Fixtures.chromiumKey, for: "dia")
    let favorites = try importer.importData(browserId: "dia", profileId: "Default", kinds: [.favorites])
    XCTAssertEqual(favorites.diaSidebar?.primarySpaceId, "space-home")
    let session = try importer.importData(browserId: "dia", profileId: "Profile 2", kinds: [.tabs])
    XCTAssertNil(session.diaSidebar)
  }

  func testAFileThatKeepsChangingFailsAfterAFewTries() throws {
    let dir = try scratch(wal: true)
    let main = dir.appendingPathComponent("tabs.db")
    var tries = 0
    XCTAssertThrowsError(try DiaDatabase.decrypt(main, key: key) {
      tries += 1
      try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(tries))], ofItemAtPath: main.path)
    }) { XCTAssertEqual(($0 as? ImportError)?.code, "unreadable") }
    XCTAssertEqual(tries, DiaDatabase.snapshotAttempts)
  }

  static let plainSchema = """
    CREATE TABLE spaces (id TEXT, title TEXT, creation_date TEXT, theme TEXT);
    CREATE TABLE nodes (id INTEGER, kind TEXT, entity_id TEXT, parent_id INTEGER, "order" INTEGER, deleted_at TEXT, space_id TEXT);
    CREATE TABLE tab_groups (id TEXT, node_id INTEGER, title TEXT, theme TEXT, icon TEXT);
    CREATE TABLE content_panes (id TEXT, node_id INTEGER, custom_title TEXT);
    CREATE TABLE web_contents (id INTEGER PRIMARY KEY, content_pane_id TEXT, url TEXT, title TEXT);
    """

  func plainSidebar(_ sql: String) throws -> SQLiteSnapshot {
    var db: OpaquePointer?
    XCTAssertEqual(sqlite3_open(":memory:", &db), SQLITE_OK)
    defer { sqlite3_close(db) }
    XCTAssertEqual(sqlite3_exec(db, Self.plainSchema + sql, nil, nil, nil), SQLITE_OK, String(cString: sqlite3_errmsg(db)))
    var size: sqlite3_int64 = 0
    let bytes = try XCTUnwrap(sqlite3_serialize(db, "main", &size, 0))
    defer { sqlite3_free(bytes) }
    return try SQLiteSnapshot(memory: Data(bytes: bytes, count: Int(size)), name: "tabs.db")
  }

  func testDuplicateNodeIdsCannotBranchACycle() throws {
    let db = try plainSidebar("""
      INSERT INTO spaces VALUES ('a', 'Alpha', '1', NULL);
      INSERT INTO nodes VALUES (1, 'window', 'w1', NULL, 0, NULL, 'a'), (2, 'group', 'g2', 1, 0, NULL, 'a'),
        (3, 'group', 'g3', 2, 0, NULL, 'a'), (3, 'group', 'g3', 2, 1, NULL, 'a'), (2, 'group', 'g2', 3, 2, NULL, 'a'),
        (2, 'group', 'g2', 3, 3, NULL, 'a'), (9, 'tab', 't9', 3, 4, NULL, 'a'), (10, 'content_pane', 'p10', 9, 0, NULL, '');
      INSERT INTO tab_groups VALUES ('g2', 2, 'Loop', NULL, NULL), ('g3', 3, 'Inner', NULL, NULL);
      INSERT INTO content_panes VALUES ('p10', 10, NULL);
      INSERT INTO web_contents (content_pane_id, url, title) VALUES ('p10', 'https://x.example/', 'X');
      """)
    let done = DispatchSemaphore(value: 0)
    var spaces: [SpaceSuggestion]?
    DispatchQueue.global().async {
      spaces = try? DiaSidebar.read(db, profileId: "Default").spaces
      done.signal()
    }
    guard done.wait(timeout: .now() + 10) == .success else { return XCTFail("the read didn't finish") }
    XCTAssertEqual(spaces?.map { titles($0.openGroups ?? []) }, [["Loop[Inner[X]]"]])
  }

  func testAChildWithItsOwnSpaceLandsInThatSpaceNotItsWindows() throws {
    let db = try plainSidebar("""
      INSERT INTO spaces VALUES ('a', 'Alpha', '1', NULL), ('b', 'Beta', '2', NULL);
      INSERT INTO nodes VALUES (1, 'window', 'w1', NULL, 0, NULL, 'a'),
        (2, 'tab', 't2', 1, 0, NULL, 'a'), (3, 'content_pane', 'p3', 2, 0, NULL, ''),
        (4, 'tab', 't4', 1, 1, NULL, 'b'), (5, 'content_pane', 'p5', 4, 0, NULL, ''),
        (6, 'group', 'g6', 1, 2, NULL, 'b'), (7, 'tab', 't7', 6, 0, NULL, 'b'), (8, 'content_pane', 'p8', 7, 0, NULL, ''),
        (11, 'tab', 't11', 1, 3, NULL, ''), (12, 'content_pane', 'p12', 11, 0, NULL, '');
      INSERT INTO tab_groups VALUES ('g6', 6, 'Group B', NULL, NULL);
      INSERT INTO content_panes VALUES ('p3', 3, NULL), ('p5', 5, NULL), ('p8', 8, NULL), ('p12', 12, NULL);
      INSERT INTO web_contents (content_pane_id, url, title) VALUES ('p3', 'https://a.example/', 'A'),
        ('p5', 'https://b.example/', 'B'), ('p8', 'https://g.example/', 'G'), ('p12', 'https://inherit.example/', 'I');
      """)
    let spaces = try DiaSidebar.read(db, profileId: "Default").spaces
    XCTAssertEqual(spaces.map(\.name), ["Alpha", "Beta"])
    XCTAssertEqual(spaces.map { $0.tabs.map(\.url) }, [["https://a.example/", "https://inherit.example/"], ["https://b.example/"]])
    XCTAssertEqual(spaces.map { titles($0.openGroups ?? []) }, [[], ["Group B[G]"]])
  }

  func testAnEmptyFirstSpaceStaysPrimarySoALaterSpaceIsNot() throws {
    let db = try plainSidebar("""
      INSERT INTO spaces VALUES ('home', 'Home', '1', NULL), ('work', 'Work', '2', NULL);
      INSERT INTO nodes VALUES (1, 'pinned_container', 'c1', NULL, 0, NULL, 'work'),
        (2, 'tab', 't2', 1, 0, NULL, 'work'), (3, 'content_pane', 'p3', 2, 0, NULL, '');
      INSERT INTO content_panes VALUES ('p3', 3, NULL);
      INSERT INTO web_contents (content_pane_id, url, title) VALUES ('p3', 'https://work.example/', 'W');
      """)
    let sidebar = try DiaSidebar.read(db, profileId: "Default")
    XCTAssertEqual(sidebar.spaces.map(\.id), ["work"])
    XCTAssertEqual(sidebar.primarySpaceId, "home")
  }

  func testAnImportOfOneKindDropsSpacesWithNothingOfThatKind() throws {
    let importer = Importer(discovery: Fixtures.discovery())
    importer.setKey(Fixtures.chromiumKey, for: "dia")
    let pinned = try importer.importData(browserId: "dia", profileId: "Default", kinds: [.pinnedTabs])
    XCTAssertEqual(pinned.spaces.map(\.name), ["Home"])
    let favorites = try importer.importData(browserId: "dia", profileId: "Default", kinds: [.favorites])
    XCTAssertEqual(favorites.spaces.map(\.name), ["Home", "Side"])
  }

  func links(_ node: BookmarkNode) -> [String] {
    node.type == .url ? [node.url ?? ""] : (node.children ?? []).flatMap(links)
  }

  func testTheTreeKeepsSpacesFavoritesPinnedFoldersSplitsAndOpenGroups() throws {
    let spaces = try sidebar().spaces
    XCTAssertEqual(spaces.map(\.name), ["Home", "Side"])
    XCTAssertEqual(spaces.map(\.profileId), ["Default", "Default"])
    XCTAssertEqual(spaces[0].color, "#E3B341")
    let home = spaces[0]
    XCTAssertEqual(home.favorites?.map(\.url), ["https://mail.dia.example/", "https://calendar.dia.example/"])
    XCTAssertEqual(home.favorites?.allSatisfy(\.pinned), true)
    XCTAssertEqual(titles(home.pinned), ["Team docs", "Reading[Read one,Deep[Deep read]]", "split[Left,Right]"])
    XCTAssertEqual(home.pinned[0].pageTitle, "Docs")
    XCTAssertEqual(home.pinned[1].icon, "📚")
    XCTAssertEqual(home.pinned[1].color, "blue")
    XCTAssertNil(home.pinned[1].children?[1].icon)
    XCTAssertNil(home.pinned[1].children?[1].color)
    XCTAssertFalse(home.pinned.flatMap(links).contains("https://gone.dia.example/"))

    XCTAssertEqual(home.tabs.map(\.url), ["https://news.dia.example/story", "https://code.dia.example/", "https://preview.dia.example/"])
    XCTAssertNil(home.tabs[0].splitId)
    XCTAssertNotNil(home.tabs[1].splitId)
    XCTAssertEqual(home.tabs[1].splitId, home.tabs[2].splitId)
    XCTAssertEqual(titles(home.openGroups ?? []), ["Research[Paper,Sources[Primary source]]", "Later[Later]"])
    XCTAssertEqual(home.openGroups?.map(\.icon), ["🔬", "⏰"])
    XCTAssertEqual(home.openGroups?.map(\.color), ["purple", "orange"])
    let source = try XCTUnwrap(home.openGroups?[0].children?[1].children?[0])
    XCTAssertEqual([source.title, source.pageTitle], ["Primary source", "Source A"])
    XCTAssertFalse(home.tabs.map(\.url).contains("https://closed.dia.example/"))

    XCTAssertEqual(spaces[1].favorites?.map(\.url), ["https://chat.dia.example/"])
    XCTAssertEqual(titles(spaces[1].openGroups ?? []), ["Errands[List]"])
    XCTAssertEqual(spaces[1].openGroups?.first?.icon, "🛒")
    XCTAssertNil(spaces[1].openGroups?.first?.color)
  }

  func testTheImporterReadsTheSidebarForTheTabKindsAndCountsThem() throws {
    let importer = Importer(discovery: Fixtures.discovery())
    importer.setKey(Fixtures.chromiumKey, for: "dia")
    let result = try importer.importData(browserId: "dia", profileId: "Default", kinds: [.bookmarks, .tabs, .pinnedTabs, .favorites])
    XCTAssertEqual(result.failed, [])
    XCTAssertEqual(result.spaces.map(\.name), ["Home", "Side"])
    XCTAssertEqual(result.tabs, [])
    XCTAssertEqual(result.favorites, [])
    XCTAssertNotNil(result.bookmarks)

    let some = try importer.importData(browserId: "dia", profileId: "Default", kinds: [.tabs])
    XCTAssertEqual(some.spaces[0].pinned, [])
    XCTAssertEqual(some.spaces[0].favorites, [])
    XCTAssertEqual(some.spaces[0].tabs.count, 3)
  }

  func testWithoutTheKeyTheSidebarKindsFailAndTheRestStillImports() throws {
    let importer = Importer(discovery: Fixtures.discovery())
    let result = try importer.importData(browserId: "dia", profileId: "Default", kinds: [.bookmarks, .tabs, .pinnedTabs])
    XCTAssertEqual(result.failed, [.tabs, .pinnedTabs])
    XCTAssertEqual(result.warnings.map(\.code), [.locked, .locked])
    XCTAssertNotNil(result.bookmarks)
    XCTAssertEqual(result.spaces, [])
  }

  func testAWrongKeyFailsTheSidebarKindsAsUnreadable() throws {
    let importer = Importer(discovery: Fixtures.discovery())
    importer.setKey(ChromiumCrypto.deriveKey(secret: Data("some-other-secret".utf8)), for: "dia")
    let result = try importer.importData(browserId: "dia", profileId: "Default", kinds: [.tabs, .favorites])
    XCTAssertEqual(result.failed, [.tabs, .favorites])
    XCTAssertEqual(result.warnings.map(\.code), [.unreadable, .unreadable])
  }

  func testDiscoveryOffersTheSidebarKindsOnlyWhereTabsDBExists() throws {
    let dia = try XCTUnwrap(Fixtures.discovery().list().first { $0.id == "dia" })
    let personal = try XCTUnwrap(dia.profiles.first { $0.id == "Default" })
    XCTAssertTrue(personal.diaSidebar)
    XCTAssertTrue(personal.tabsNeedKey)
    XCTAssertTrue([ImportKind.tabs, .pinnedTabs, .favorites].allSatisfy(personal.available.contains))
    let work = try XCTUnwrap(dia.profiles.first { $0.id == "Profile 2" })
    XCTAssertFalse(work.diaSidebar)
    XCTAssertFalse(work.tabsNeedKey)
    XCTAssertFalse(work.available.contains(.favorites))
  }

  func testFaviconPagesIncludeOpenGroupsAndFavorites() throws {
    let importer = Importer(discovery: Fixtures.discovery())
    importer.setKey(Fixtures.chromiumKey, for: "dia")
    let result = try importer.importData(browserId: "dia", profileId: "Default", kinds: [.tabs, .favorites])
    let pages = ChromiumFavicons.pages(of: result)
    XCTAssertTrue(pages.contains("https://paper.dia.example/"))
    XCTAssertTrue(pages.contains("https://mail.dia.example/"))
  }
}
