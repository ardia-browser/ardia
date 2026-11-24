import Foundation
import ImageIO
import SQLite3
import XCTest
@testable import ArdiaImportCore

final class FirefoxFaviconsTests: XCTestCase {
  private var directories: [URL] = []
  private let zenMain = "Profiles/zen12345.Default (release)"

  override func tearDown() {
    for directory in directories { try? FileManager.default.removeItem(at: directory) }
    directories = []
  }

  private func image(_ width: Int, _ height: Int, type: String = "public.png") -> Data {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(CGColor(srgbRed: 0.2, green: 0.4, blue: 0.8, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let out = NSMutableData()
    let destination = CGImageDestinationCreateWithData(out, type as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return out as Data
  }

  private func png(_ side: Int) -> Data { image(side, side) }

  private func size(_ base64: String?) -> [Int]? {
    base64.flatMap { Data(base64Encoded: $0) }.flatMap(FirefoxFavicons.pngSize).map { [$0.width, $0.height] }
  }

  private struct Row {
    var page: String?
    var icon: String
    var width = 16
    var data: Data
    var root = false
    var asText = false
  }

  private func database(_ path: URL, _ statements: [(String, [Any])]) {
    var db: OpaquePointer?
    XCTAssertEqual(sqlite3_open(path.path, &db), SQLITE_OK)
    defer { sqlite3_close(db) }
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    for (sql, values) in statements {
      var stmt: OpaquePointer?
      XCTAssertEqual(sqlite3_prepare_v2(db, sql, -1, &stmt, nil), SQLITE_OK, sql)
      for (i, value) in values.enumerated() {
        let at = Int32(i + 1)
        switch value {
        case let text as String: sqlite3_bind_text(stmt, at, text, -1, transient)
        case let number as Int: sqlite3_bind_int64(stmt, at, Int64(number))
        case let blob as Data: _ = blob.withUnsafeBytes { sqlite3_bind_blob(stmt, at, $0.baseAddress, Int32(blob.count), transient) }
        default: sqlite3_bind_null(stmt, at)
        }
      }
      XCTAssertEqual(sqlite3_step(stmt), SQLITE_DONE, sql)
      sqlite3_finalize(stmt)
    }
  }

  private func profile(_ rows: [Row], visits: [(url: String, at: Int)] = []) throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("firefox-favicons-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    directories.append(directory)
    var statements: [(String, [Any])] = [
      ("CREATE TABLE moz_icons (id INTEGER PRIMARY KEY, icon_url TEXT NOT NULL, fixed_icon_url_hash INTEGER NOT NULL DEFAULT 0, width INTEGER NOT NULL DEFAULT 0, root INTEGER NOT NULL DEFAULT 0, data BLOB)", []),
      ("CREATE TABLE moz_pages_w_icons (id INTEGER PRIMARY KEY, page_url TEXT NOT NULL, page_url_hash INTEGER NOT NULL DEFAULT 0)", []),
      ("CREATE TABLE moz_icons_to_pages (page_id INTEGER NOT NULL, icon_id INTEGER NOT NULL, PRIMARY KEY (page_id, icon_id)) WITHOUT ROWID", []),
    ]
    var pageIds: [String: Int] = [:]
    for (i, row) in rows.enumerated() {
      let data: Any = row.asText ? String(decoding: row.data, as: UTF8.self) : row.data
      statements.append(("INSERT INTO moz_icons (id, icon_url, width, root, data) VALUES (?, ?, ?, ?, ?)", [i + 1, row.icon, row.width, row.root ? 1 : 0, data]))
      guard let page = row.page else { continue }
      if pageIds[page] == nil {
        pageIds[page] = pageIds.count + 1
        statements.append(("INSERT INTO moz_pages_w_icons (id, page_url) VALUES (?, ?)", [pageIds[page]!, page]))
      }
      statements.append(("INSERT INTO moz_icons_to_pages (page_id, icon_id) VALUES (?, ?)", [pageIds[page]!, i + 1]))
    }
    database(directory.appendingPathComponent("favicons.sqlite"), statements)
    database(directory.appendingPathComponent("places.sqlite"), [
      ("CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, rev_host TEXT, last_visit_date INTEGER)", []),
      ("CREATE INDEX moz_places_hostindex ON moz_places (rev_host)", []),
    ] + visits.map { visit in
      let host = URLComponents(string: visit.url)!.host!.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
      return ("INSERT INTO moz_places (url, rev_host, last_visit_date) VALUES (?, ?, ?)", [visit.url, String(host.reversed()) + ".", visit.at])
    })
    return directory
  }

  private func read(_ dir: URL, _ pages: [String], known: [ImportedFavicon] = []) throws -> [ImportedFavicon] {
    try FirefoxFavicons.merged(profile: dir, pages: pages, known: known)
  }

  func testTheRealPNGHeaderDecidesNotTheWidthColumn() throws {
    let dir = try profile([
      Row(page: "https://a.test/", icon: "https://a.test/lies-small.png", width: 16, data: png(128)),
      Row(page: "https://a.test/", icon: "https://a.test/lies-big.png", width: 512, data: png(32)),
      Row(page: "https://a.test/", icon: "https://a.test/16.png", width: 16, data: png(16)),
      Row(page: "https://a.test/", icon: "https://a.test/tall.png", width: 32, data: image(32, 96)),
      Row(page: "https://big.test/", icon: "https://big.test/96.png", width: 32, data: png(96)),
      Row(page: "https://jpeg.test/", icon: "https://jpeg.test/i.jpg", width: 32, data: image(32, 32, type: "public.jpeg")),
      Row(page: "https://ico.test/", icon: "https://ico.test/i.ico", width: 32, data: image(32, 32, type: "com.microsoft.ico")),
      Row(page: "https://text.test/", icon: "https://text.test/i.png", width: 32, data: png(32), asText: true),
      Row(page: "https://short.test/", icon: "https://short.test/i.png", width: 32, data: Data(ChromiumFavicons.pngSignature)),
      Row(page: "https://huge.test/", icon: "https://huge.test/i.png", width: 32, data: png(32) + Data(count: ChromiumFavicons.maximumPNGBytes)),
    ])
    let icons = try read(dir, ["https://a.test/", "https://big.test/", "https://jpeg.test/", "https://ico.test/", "https://text.test/",
                               "https://short.test/", "https://huge.test/"])
    XCTAssertEqual(icons.map(\.icon), ["https://a.test/lies-big.png"])
    XCTAssertEqual(size(icons.first?.png), [32, 32])
  }

  func testSVGIconsAreSkippedNeverDrawn() throws {
    let svg = Data(##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#2a7"/></svg>"##.utf8)
    let dir = try profile([
      Row(page: "https://svg.test/", icon: "https://svg.test/i.svg", width: 65535, data: svg),
      Row(page: "https://both.test/", icon: "https://both.test/i.svg", width: 65535, data: svg),
      Row(page: "https://both.test/", icon: "https://both.test/16.png", width: 16, data: png(16)),
    ])
    XCTAssertEqual(try read(dir, ["https://svg.test/", "https://both.test/"]).map(\.icon), ["https://both.test/16.png"])
  }

  func testOwnPageThenValidRootIconThenHomeThenRecentlyVisitedPages() throws {
    let dir = try profile([
      Row(page: "https://own.test/a", icon: "https://own.test/a.png", data: png(16)),
      Row(page: nil, icon: "https://own.test/favicon.ico", data: png(32), root: true),
      Row(page: nil, icon: "http://www.alias.test/favicon.ico", data: png(16), root: true),
      Row(page: nil, icon: "https://query.test/favicon.ico?v=2", data: png(16), root: true),
      Row(page: nil, icon: "https://path.test/icon.png", data: png(16), root: true),
      Row(page: nil, icon: "ftp://ftp.test/favicon.ico", data: png(16), root: true),
      Row(page: nil, icon: "https://port.test:8443/favicon.ico", data: png(16), root: true),
      Row(page: nil, icon: "https://default-port.test:443/favicon.ico", data: png(16), root: true),
      Row(page: nil, icon: "https://xn--bcher-kva.test/favicon.ico", data: png(16), root: true),
      Row(page: nil, icon: "https://flag.test/favicon.ico", data: png(16), root: false),
      Row(page: nil, icon: "https://user@userinfo.test/favicon.ico", data: png(16), root: true),
      Row(page: nil, icon: "https://fragment.test/favicon.ico#x", data: png(16), root: true),
      Row(page: "https://home.test/", icon: "https://home.test/home.png", data: png(16)),
      Row(page: "https://home.test/recent", icon: "https://home.test/recent.png", data: png(16)),
      Row(page: "https://recent.test/old", icon: "https://recent.test/old.png", data: png(16)),
      Row(page: "https://recent.test/new", icon: "https://recent.test/new.png", data: png(16)),
      Row(page: "https://recent.test/unvisited", icon: "https://recent.test/unvisited.png", data: png(16)),
      Row(page: "http://recent.test/other-scheme", icon: "http://recent.test/other-scheme.png", data: png(16)),
      Row(page: "https://recent.test.evil/", icon: "https://recent.test.evil/x.png", data: png(16)),
    ], visits: [
      ("https://home.test/recent", 900), ("https://recent.test/old", 100), ("https://recent.test/new", 200),
      ("http://recent.test/other-scheme", 999), ("https://recent.test.evil/", 999),
    ])
    let icons = try read(dir, [
      "https://own.test/a", "https://own.test/b", "https://alias.test/page", "https://query.test/", "https://path.test/",
      "https://ftp.test/", "https://port.test/", "https://default-port.test/", "https://xn--bcher-kva.test/x", "https://Bücher.test/y", "https://flag.test/",
      "https://userinfo.test/", "https://fragment.test/", "https://home.test/deep", "https://recent.test/deep",
    ])
    XCTAssertEqual(Dictionary(uniqueKeysWithValues: icons.map { ($0.page, $0.icon) }), [
      "https://own.test/a": "https://own.test/a.png",
      "https://own.test/b": "https://own.test/favicon.ico",
      "https://alias.test/page": "http://www.alias.test/favicon.ico",
      "https://default-port.test/": "https://default-port.test:443/favicon.ico",
      "https://xn--bcher-kva.test/x": "https://xn--bcher-kva.test/favicon.ico",
      "https://home.test/deep": "https://home.test/home.png",
      "https://recent.test/deep": "https://recent.test/new.png",
    ])
  }

  func testZenIconsAreKeptAndPagesCountOncePerFragmentFreeAddress() throws {
    let dir = try profile([
      Row(page: "https://kept.test/", icon: "https://kept.test/db.png", data: png(16)),
      Row(page: "https://frag.test/x", icon: "https://frag.test/x.png", data: png(16)),
    ])
    let zen = [ImportedFavicon(page: "https://kept.test/#zen", icon: "https://kept.test/favicon.ico", png: "AAAA"),
               ImportedFavicon(page: "https://kept.test/", icon: "dup", png: "BBBB")]
    let icons = try read(dir, ["https://kept.test/", "https://frag.test/x#1", "https://frag.test/x#2"], known: zen)
    XCTAssertEqual(icons.map(\.page), ["https://kept.test/#zen", "https://frag.test/x#1"])
    XCTAssertEqual(icons[1].icon, "https://frag.test/x.png")
  }

  func testThePageCapAndByteBudgetSpanZenAndTheDatabase() throws {
    let dir = try profile([
      Row(page: "https://a.test/", icon: "https://a.test/i.png", data: png(16)),
      Row(page: "https://b.test/", icon: "https://b.test/i.png", data: png(16)),
    ])
    let zen = (0..<(ChromiumFavicons.maximumPages - 1)).map { ImportedFavicon(page: "https://zen\($0).test/", icon: "z", png: "AAAA") }
    let capped = try read(dir, ["https://a.test/", "https://b.test/"], known: zen)
    XCTAssertEqual(capped.count, ChromiumFavicons.maximumPages)
    XCTAssertEqual(capped.last?.page, "https://a.test/")

    let full = [ImportedFavicon(page: "https://zen.test/", icon: "z", png: String(repeating: "A", count: ChromiumFavicons.maximumTotalBytes))]
    XCTAssertEqual(try read(dir, ["https://a.test/"], known: full).map(\.page), ["https://zen.test/"])
  }

  func testBoundURLsAMissingDatabaseAndCancellation() throws {
    let quoted = "https://quote.test/it's?q='); DROP TABLE moz_icons; --"
    let dir = try profile([Row(page: quoted, icon: "https://quote.test/i.png", data: png(16))])
    XCTAssertEqual(try read(dir, [quoted, "file:///tmp/a.html"]).map(\.page), [quoted])
    let missing = FileManager.default.temporaryDirectory.appendingPathComponent("firefox-favicons-missing-\(UUID().uuidString)")
    XCTAssertEqual(try read(missing, [quoted]), [])
    let cancelled = Cancellation()
    cancelled.cancel()
    XCTAssertThrowsError(try FirefoxFavicons.merged(profile: dir, pages: [quoted], known: [], cancellation: cancelled)) {
      XCTAssertEqual($0 as? ImportError, .cancelled)
    }
  }

  private func chunk(_ type: String, _ body: [UInt8]) -> [UInt8] {
    let length = UInt32(body.count)
    return [UInt8(length >> 24), UInt8(length >> 16 & 255), UInt8(length >> 8 & 255), UInt8(length & 255)] + Array(type.utf8) + body + [0, 0, 0, 0]
  }

  private func handMade(_ side: Int, chunks: [String] = ["IHDR", "IDAT", "IEND"], ihdrLength: Int = 13, trailing: [UInt8] = []) -> Data {
    var bytes = [UInt8](ChromiumFavicons.pngSignature)
    for name in chunks {
      switch name {
      case "IHDR":
        let s = UInt32(side)
        let dims = [UInt8(s >> 24), UInt8(s >> 16 & 255), UInt8(s >> 8 & 255), UInt8(s & 255)]
        bytes += chunk("IHDR", Array((dims + dims + [8, 6, 0, 0, 0] + [UInt8](repeating: 0, count: 13)).prefix(ihdrLength)))
      case "IDAT": bytes += chunk("IDAT", [1, 2, 3, 4])
      case "IEND": bytes += chunk("IEND", [])
      default: bytes += chunk(name, [9])
      }
    }
    return Data(bytes + trailing)
  }

  func testOnlyACompletePNGChunkStructureCounts() throws {
    let whole = png(64)
    let dir = try profile([
      Row(page: "https://cut.test/", icon: "https://cut.test/64-cut.png", width: 64, data: whole.prefix(40)),
      Row(page: "https://cut.test/", icon: "https://cut.test/16.png", width: 16, data: png(16)),
      Row(page: "https://no-end.test/", icon: "https://no-end.test/i.png", data: handMade(32, chunks: ["IHDR", "IDAT"])),
      Row(page: "https://no-data.test/", icon: "https://no-data.test/i.png", data: handMade(32, chunks: ["IHDR", "IEND"])),
      Row(page: "https://trailing.test/", icon: "https://trailing.test/i.png", data: handMade(32, trailing: [0])),
      Row(page: "https://short-ihdr.test/", icon: "https://short-ihdr.test/i.png", data: handMade(32, ihdrLength: 12)),
      Row(page: "https://two-ihdr.test/", icon: "https://two-ihdr.test/i.png", data: handMade(32, chunks: ["IHDR", "IHDR", "IDAT", "IEND"])),
      Row(page: "https://overrun.test/", icon: "https://overrun.test/i.png", data: handMade(32, chunks: ["IHDR", "IDAT"]) + Data([0, 0, 1, 0]) + Data("IEND".utf8)),
      Row(page: "https://extra.test/", icon: "https://extra.test/i.png", data: handMade(32, chunks: ["IHDR", "tEXt", "IDAT", "IEND"])),
    ])
    let icons = try read(dir, ["https://cut.test/", "https://no-end.test/", "https://no-data.test/", "https://trailing.test/",
                               "https://short-ihdr.test/", "https://two-ihdr.test/", "https://overrun.test/", "https://extra.test/"])
    XCTAssertEqual(icons.map(\.icon), ["https://cut.test/16.png", "https://extra.test/i.png"])
  }

  func testZenSessionIconsMatchByFragmentFreeAddressAndCountOnce() {
    let big = String(repeating: "A", count: ChromiumFavicons.maximumTotalBytes - 6)
    let icons = [
      ImportedFavicon(page: "https://a.test/#tab", icon: "a", png: "AAAA"),
      ImportedFavicon(page: "https://a.test/", icon: "a-again", png: big),
      ImportedFavicon(page: "https://b.test/", icon: "b", png: big),
      ImportedFavicon(page: "https://c.test/", icon: "c", png: "AAAA"),
      ImportedFavicon(page: "https://other.test/", icon: "x", png: "AAAA"),
    ]
    let sidebar = ZenSidebar(favicons: icons)
    XCTAssertEqual(sidebar.favicons(for: ["https://a.test/", "https://b.test/#x", "https://c.test/"]).map(\.icon), ["a", "b"])
    let many = (0..<1005).map { ImportedFavicon(page: "https://p\($0).test/", icon: "\($0)", png: "AAAA") }
    XCTAssertEqual(ZenSidebar(favicons: many).favicons(for: many.map(\.page)).count, ChromiumFavicons.maximumPages)
  }

  func testHostsAndPortsMustBeASCIIBeforeTheyAreNormalised() throws {
    let dir = try profile([
      Row(page: nil, icon: "https://\u{212A}elvin.test/favicon.ico", data: png(16), root: true),
      Row(page: nil, icon: "https://plus.test:+8443/favicon.ico", data: png(16), root: true),
      Row(page: nil, icon: "https://wide.test:\u{FF18}443/favicon.ico", data: png(16), root: true),
      Row(page: nil, icon: "https://port.test:8443/favicon.ico", data: png(16), root: true),
    ])
    let icons = try read(dir, ["https://kelvin.test/", "https://plus.test:8443/", "https://wide.test:8443/", "https://port.test:8443/x"])
    XCTAssertEqual(icons.map(\.icon), ["https://port.test:8443/favicon.ico"])
  }

  func testIPv6AndUnparsedPagesStillGetTheirOwnIcons() throws {
    let dir = try profile([
      Row(page: "http://[::1]/a", icon: "http://[::1]/a.png", data: png(16)),
      Row(page: "http://[::1]/", icon: "http://[::1]/home.png", data: png(16)),
      Row(page: nil, icon: "http://[::1]:8080/favicon.ico", data: png(16), root: true),
      Row(page: "https://odd host.test/x", icon: "https://odd host.test/x.png", data: png(16)),
      Row(page: "http://[fe80::1]/old", icon: "http://[fe80::1]/old.png", data: png(16)),
    ], visits: [("http://[fe80::1]/old", 5)])
    let icons = try read(dir, ["http://[::1]/a", "http://[::1]/b", "http://[::1]:8080/c", "https://odd host.test/x", "http://[fe80::1]/new"])
    XCTAssertEqual(Dictionary(uniqueKeysWithValues: icons.map { ($0.page, $0.icon) }), [
      "http://[::1]/a": "http://[::1]/a.png",
      "http://[::1]/b": "http://[::1]/home.png",
      "http://[::1]:8080/c": "http://[::1]:8080/favicon.ico",
      "https://odd host.test/x": "https://odd host.test/x.png",
      "http://[fe80::1]/new": "http://[fe80::1]/old.png",
    ])
  }

  func testEveryExactAddressOfAFragmentFreePageIsTriedBeforeTheSite() throws {
    let dir = try profile([
      Row(page: "https://docs.test/report#second", icon: "https://docs.test/second.png", data: png(16)),
      Row(page: "https://cut.test/page#x", icon: "https://cut.test/cut.png", data: png(64).prefix(40)),
      Row(page: "https://cut.test/page", icon: "https://cut.test/page.png", data: png(16)),
      Row(page: "https://cut.test/", icon: "https://cut.test/home.png", data: png(32)),
    ])
    let icons = try read(dir, ["https://docs.test/report#first", "https://docs.test/report#second", "https://cut.test/page#x"])
    XCTAssertEqual(icons.map { [$0.page, $0.icon] }, [
      ["https://docs.test/report#first", "https://docs.test/second.png"],
      ["https://cut.test/page#x", "https://cut.test/page.png"],
    ])
  }

  func testFirefoxImportBringsIconsForTabsAndTheBookmarksToolbar() throws {
    let importer = Importer(discovery: Fixtures.discovery())
    let result = try importer.importData(browserId: "firefox", profileId: "Profiles/abcd1234.default-release", kinds: [.bookmarks, .tabs])
    XCTAssertEqual(result.favicons.map { [$0.page, $0.icon] }, [
      ["https://www.mozilla.example/", "https://www.mozilla.example/icon-32.png"],
      ["https://developer.mozilla.example/docs", "https://developer.mozilla.example/favicon.ico"],
    ])
    XCTAssertEqual(size(result.favicons.first?.png), [32, 32])
    let history = try importer.importData(browserId: "firefox", profileId: "Profiles/abcd1234.default-release", kinds: [.history])
    XCTAssertEqual(history.favicons, [])
  }

  func testZenImportKeepsSessionIconsAndFillsTheRestFromFavicons() throws {
    let importer = Importer(discovery: Fixtures.discovery())
    let result = try importer.importData(browserId: "zen", profileId: zenMain, kinds: [.tabs, .spaces, .pinnedTabs, .favorites])
    XCTAssertEqual(result.favicons.map { [$0.page, $0.icon] }, [
      ["https://chat.example/room", "https://chat.example/favicon.ico"],
      ["https://play.example/", "https://play.example/favicon.ico"],
      ["https://mail.example/", "https://mail.example/mail.png"],
      ["https://docs.example/a", "https://www.docs.example/favicon.ico"],
    ])
  }
}
