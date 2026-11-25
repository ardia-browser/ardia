import ArdiaCoreRS
import Foundation
import XCTest
@testable import ArdiaImportCore

final class ChromiumBookmarksTests: XCTestCase {
  private var profile: URL!

  override func setUpWithError() throws {
    profile = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-chromium-bookmarks-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: profile)
  }

  private func write(_ name: String, _ text: String) throws {
    try Data(text.utf8).write(to: profile.appendingPathComponent(name))
  }

  func testTheRustParserReadsBothFilesAndReportsItsBackend() throws {
    try write("Bookmarks", #"{"roots":{"bookmark_bar":{"type":"folder","name":"","children":[{"type":"url","name":"Ardia","url":"https://ardia.dev/","date_added":"13350000000000000"}]},"other":{"type":"folder","children":[]}}}"#)
    try write("AccountBookmarks", #"{"roots":{"bookmark_bar":{"type":"folder","children":[{"type":"url","name":"Account","url":"https://account.example/"}]},"synced":{"type":"folder","children":[{"type":"url","url":"https://phone.example/"}]}}}"#)
    let read = ChromiumBookmarks.read(profile: profile)
    XCTAssertEqual(read.core, ImportCoreRead(format: .chromiumBookmarks, backend: .rust, outcome: .ok))
    let tree = try read.tree.get()
    XCTAssertEqual(tree.title, "Bookmarks")
    XCTAssertEqual(tree.children?.map(\.role), ["toolbar", "mobile"])
    XCTAssertEqual(tree.children?.map(\.title), ["Bookmarks Bar", "Mobile Bookmarks"])
    XCTAssertEqual(tree.children?.first?.children?.map(\.url), ["https://ardia.dev/", "https://account.example/"])
    XCTAssertEqual(tree.children?.first?.children?.first?.dateAdded, 1_705_526_400_000)
    XCTAssertEqual(tree.linkCount, 3)
  }

  func testNoFilesIsNotFoundAndBrokenJsonIsUnreadable() throws {
    let missing = ChromiumBookmarks.read(profile: profile)
    XCTAssertEqual(missing.core.outcome, .notFound)
    XCTAssertThrowsError(try missing.tree.get()) { XCTAssertEqual(($0 as? ImportError)?.code, "notFound") }

    try write("Bookmarks", #"{"roots":{"bookmark_bar":{"type":"folder","children":[],}}}"#)
    let broken = ChromiumBookmarks.read(profile: profile)
    XCTAssertEqual(broken.core.outcome, .unreadable)
    XCTAssertThrowsError(try ChromiumBookmarks.load(profile: profile)) { XCTAssertEqual(($0 as? ImportError)?.code, "unreadable") }
  }

  func testAnEmptyOrUnreadableBookmarksFileFailsButAnUnreadableAccountFileIsSkipped() throws {
    try write("Bookmarks", "")
    XCTAssertEqual(ChromiumBookmarks.read(profile: profile).core.outcome, .unreadable)

    try FileManager.default.removeItem(at: profile.appendingPathComponent("Bookmarks"))
    try FileManager.default.createDirectory(at: profile.appendingPathComponent("AccountBookmarks"), withIntermediateDirectories: false)
    let read = ChromiumBookmarks.read(profile: profile)
    XCTAssertEqual(read.core.outcome, .ok)
    XCTAssertEqual(try read.tree.get(), .folder("Bookmarks", []))
  }

  func testAFileOverTheCapIsTooLargeForTelemetryAndUnreadableForTheApp() throws {
    let handle = try FileHandle(forWritingTo: { () -> URL in
      let url = profile.appendingPathComponent("Bookmarks")
      FileManager.default.createFile(atPath: url.path, contents: Data("{}".utf8))
      return url
    }())
    try handle.truncate(atOffset: 64 * 1024 * 1024 + 1)
    try handle.close()
    let read = ChromiumBookmarks.read(profile: profile)
    XCTAssertEqual(read.core.outcome, .tooLarge)
    XCTAssertThrowsError(try read.tree.get()) { XCTAssertEqual(($0 as? ImportError)?.code, "unreadable") }
  }


  func testProfileFilesAreMissingUnreadableOversizedOrOwnedBytes() throws {
    XCTAssertEqual(ProfileFile(profile.appendingPathComponent("Bookmarks")), .missing)
    XCTAssertEqual(ProfileFile(profile.appendingPathComponent("Bookmarks/inside")), .missing)

    try write("Bookmarks", "{}")
    XCTAssertEqual(ProfileFile(profile.appendingPathComponent("Bookmarks")), .bytes(Data("{}".utf8)))

    let folder = profile.appendingPathComponent("Folder")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
    XCTAssertEqual(ProfileFile(folder), .unreadable)

    let fifo = profile.appendingPathComponent("Fifo")
    XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
    XCTAssertEqual(ProfileFile(fifo), .unreadable)

    let locked = profile.appendingPathComponent("Locked")
    try write("Locked", "{}")
    XCTAssertEqual(chmod(locked.path, 0), 0)
    defer { chmod(locked.path, 0o600) }
    XCTAssertEqual(ProfileFile(locked), .unreadable)
  }

  func testAFileAtTheCapIsReadAndOneByteMoreIsOversizedWithoutBeingRead() throws {
    let url = profile.appendingPathComponent("Bookmarks")
    FileManager.default.createFile(atPath: url.path, contents: nil)
    let handle = try FileHandle(forWritingTo: url)
    try handle.truncate(atOffset: UInt64(ProfileFile.maxInputBytes))
    if case .bytes(let bytes) = ProfileFile(url) {
      XCTAssertEqual(bytes.count, ProfileFile.maxInputBytes)
    } else {
      XCTFail("a file of exactly the cap is read")
    }
    try handle.truncate(atOffset: UInt64(ProfileFile.maxInputBytes) + 1)
    try handle.close()
    XCTAssertEqual(ProfileFile(url), .oversized(ProfileFile.maxInputBytes + 1))
  }

  func testTheSwiftCapIsTheRustCap() {
    var out = ardia_import_buf(ptr: nil, len: 0)
    let over = ProfileFile.oversized(ProfileFile.maxInputBytes + 1).withArgument { ardia_import_chromium_bookmarks($0, nil, &out) }
    ardia_import_buf_free(&out)
    XCTAssertEqual(over, ARDIA_IMPORT_STATUS_TOO_LARGE)
    var atCap = ardia_import_bytes(ptr: nil, len: ProfileFile.maxInputBytes)
    let inRange = ardia_import_chromium_bookmarks(&atCap, nil, &out)
    ardia_import_buf_free(&out)
    XCTAssertEqual(inRange, ARDIA_IMPORT_STATUS_INVALID_ARGUMENT)
  }

  func testAnUnreadableOrOversizedAccountFileIsSkippedAndAnUnreadableBookmarksFileFails() throws {
    try write("Bookmarks", #"{"roots":{"bookmark_bar":{"type":"folder","children":[{"type":"url","url":"https://kept.example/"}]}}}"#)
    let account = profile.appendingPathComponent("AccountBookmarks")
    FileManager.default.createFile(atPath: account.path, contents: nil)
    let handle = try FileHandle(forWritingTo: account)
    try handle.truncate(atOffset: UInt64(ProfileFile.maxInputBytes) + 1)
    try handle.close()
    let read = ChromiumBookmarks.read(profile: profile)
    XCTAssertEqual(read.core.outcome, .ok)
    XCTAssertEqual(try read.tree.get().linkCount, 1)

    XCTAssertEqual(chmod(profile.appendingPathComponent("Bookmarks").path, 0), 0)
    XCTAssertEqual(ChromiumBookmarks.read(profile: profile).core.outcome, .unreadable)
  }

  func testTheImportResultCarriesTheCoreReadToJavaScript() throws {
    var result = ImportResult(browserId: "chrome", profileId: "Default")
    result.importCore.append(ImportCoreRead(format: .chromiumBookmarks, backend: .rust, outcome: .tooLarge))
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any]
    XCTAssertEqual(json?["importCore"] as? [[String: String]], [["format": "chromium_bookmarks", "backend": "rust", "outcome": "tooLarge"]])
  }
}
