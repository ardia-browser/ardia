import Foundation
import XCTest
@testable import ArdiaSyncCore

final class SharedFolderDirectoryTests: XCTestCase {
  private var scratch: URL!
  private let fm = FileManager.default

  override func setUpWithError() throws {
    scratch = fm.temporaryDirectory.appendingPathComponent("shared-folder-tests-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: scratch, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? fm.removeItem(at: scratch)
  }

  private func webloc(_ url: String) -> String {
    "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>URL</key><string>\(url)</string></dict></plist>"
  }

  private func folder(_ name: String) throws -> URL {
    let url = scratch.appendingPathComponent(name, isDirectory: true)
    try fm.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  private func ops(_ list: [[String: Any]]) throws -> String {
    String(data: try JSONSerialization.data(withJSONObject: list), encoding: .utf8)!
  }

  private func entries(_ listing: [String: Any]) -> [[String: Any]] {
    ((listing["root"] as? [String: Any])?["entries"] as? [[String: Any]]) ?? []
  }

  func testSymlinkedSubfolderIsNeitherReadNorWrittenThrough() throws {
    let outside = try folder("outside")
    try webloc("https://outside.example/").write(to: outside.appendingPathComponent("Secret.webloc"), atomically: true, encoding: .utf8)
    let root = try folder("root")
    try fm.createSymbolicLink(at: root.appendingPathComponent("Linked"), withDestinationURL: outside)
    try fm.createSymbolicLink(at: root.appendingPathComponent("Alias.webloc"), withDestinationURL: outside.appendingPathComponent("Secret.webloc"))
    let directory = SharedFolderDirectory(root: root)

    let listed = entries(directory.read())
    XCTAssertFalse(String(describing: listed).contains("outside.example"))
    XCTAssertEqual(Set(listed.compactMap { $0["file"] as? String }), ["Alias.webloc", "Linked"])
    XCTAssertTrue(listed.allSatisfy { $0["kind"] as? String == "pending" })

    for change in [
      ["op": "delete", "path": "Linked/Secret.webloc", "expect": "https://outside.example/"],
      ["op": "write", "path": "Linked/.ardia-folder.json", "text": "{}", "create": false],
      ["op": "delete", "path": "Alias.webloc", "expect": "https://outside.example/"],
    ] as [[String: Any]] {
      XCTAssertThrowsError(try directory.apply(json: try ops([change])))
    }
    XCTAssertTrue(fm.fileExists(atPath: outside.appendingPathComponent("Secret.webloc").path))
    XCTAssertFalse(fm.fileExists(atPath: outside.appendingPathComponent(".ardia-folder.json").path))
  }

  func testDeletingALinkNeverRemovesADirectoryOrAChangedLink() throws {
    let root = try folder("root")
    let trap = root.appendingPathComponent("Reading/Docs.webloc", isDirectory: true)
    try fm.createDirectory(at: trap, withIntermediateDirectories: true)
    try "pdf".write(to: trap.appendingPathComponent("report.pdf"), atomically: true, encoding: .utf8)
    try webloc("https://changed.example/").write(to: root.appendingPathComponent("Reading/Old.webloc"), atomically: true, encoding: .utf8)
    try webloc("https://keep.example/").write(to: root.appendingPathComponent("Reading/Gone.webloc"), atomically: true, encoding: .utf8)
    _ = try SharedFolderDirectory(root: root).apply(json: try ops([
      ["op": "delete", "path": "Reading/Docs.webloc", "expect": "https://docs.example/"],
      ["op": "delete", "path": "Reading/Old.webloc", "expect": "https://old.example/"],
      ["op": "delete", "path": "Reading/Gone.webloc", "expect": "https://keep.example/"],
      ["op": "rmdir", "path": "Reading"],
    ]))
    XCTAssertTrue(fm.fileExists(atPath: trap.appendingPathComponent("report.pdf").path))
    XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent("Reading/Old.webloc").path))
    XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("Reading/Gone.webloc").path))
  }

  func testCreatingANameThatExistsIsAConflictAndReplacingChecksTheOldURL() throws {
    let root = try folder("root")
    let directory = SharedFolderDirectory(root: root)
    let first = try directory.apply(json: try ops([["op": "write", "path": "Docs.webloc", "text": webloc("https://mac-a.example/"), "create": true]]))
    XCTAssertEqual(first["conflicts"] as? [String], [])
    let second = try directory.apply(json: try ops([["op": "write", "path": "Docs.webloc", "text": webloc("https://mac-b.example/"), "create": true]]))
    XCTAssertEqual(second["conflicts"] as? [String], ["Docs.webloc"])
    let stale = try directory.apply(json: try ops([["op": "write", "path": "Docs.webloc", "text": webloc("https://x.example/"), "create": false, "expect": "https://old.example/"]]))
    XCTAssertEqual(stale["conflicts"] as? [String], ["Docs.webloc"])
    XCTAssertTrue(try String(contentsOf: root.appendingPathComponent("Docs.webloc"), encoding: .utf8).contains("mac-a"))
    let current = try directory.apply(json: try ops([["op": "write", "path": "Docs.webloc", "text": webloc("https://new.example/"), "create": false, "expect": "https://mac-a.example/"]]))
    XCTAssertEqual(current["conflicts"] as? [String], [])
    XCTAssertTrue(try String(contentsOf: root.appendingPathComponent("Docs.webloc"), encoding: .utf8).contains("new.example"))
  }

  func testAMoveOntoAnExistingNameIsAConflict() throws {
    let root = try folder("root")
    try webloc("https://a.example/").write(to: root.appendingPathComponent("A.webloc"), atomically: true, encoding: .utf8)
    try webloc("https://b.example/").write(to: root.appendingPathComponent("B.webloc"), atomically: true, encoding: .utf8)
    let result = try SharedFolderDirectory(root: root).apply(json: try ops([["op": "move", "path": "A.webloc", "to": "B.webloc"]]))
    XCTAssertEqual(result["conflicts"] as? [String], ["B.webloc"])
    XCTAssertTrue(try String(contentsOf: root.appendingPathComponent("B.webloc"), encoding: .utf8).contains("b.example"))
  }

  func testAFolderThatCantBeListedIsAnErrorNotEmpty() throws {
    let root = try folder("root")
    let locked = root.appendingPathComponent("Locked", isDirectory: true)
    try fm.createDirectory(at: locked, withIntermediateDirectories: true)
    try webloc("https://x.example/").write(to: locked.appendingPathComponent("In.webloc"), atomically: true, encoding: .utf8)
    chmod(locked.path, 0o000)
    defer { chmod(locked.path, 0o755) }
    let listing = SharedFolderDirectory(root: root).read()
    XCTAssertNotNil((listing["root"] as? [String: Any])?["error"])
  }

  func testOversizedFilesAreHeldWithoutBeingRead() throws {
    let root = try folder("root")
    fm.createFile(atPath: root.appendingPathComponent("Big.webloc").path, contents: Data(count: 2_000_000))
    fm.createFile(atPath: root.appendingPathComponent(".ardia-folder.json").path, contents: Data(count: 3_000_000))
    let listing = SharedFolderDirectory(root: root).read()
    let level = listing["root"] as? [String: Any]
    XCTAssertEqual(entries(listing).first?["kind"] as? String, "pending")
    XCTAssertEqual(entries(listing).first?["reason"] as? String, "unreadable")
    XCTAssertEqual(level?["manifestPending"] as? Bool, true)
  }

  func testAFolderWithoutSearchPermissionIsAnErrorNotEmpty() throws {
    let root = try folder("root")
    let locked = root.appendingPathComponent("NoSearch", isDirectory: true)
    try fm.createDirectory(at: locked, withIntermediateDirectories: true)
    try webloc("https://x.example/").write(to: locked.appendingPathComponent("In.webloc"), atomically: true, encoding: .utf8)
    chmod(locked.path, 0o444)
    defer { chmod(locked.path, 0o755) }
    let listing = SharedFolderDirectory(root: root).read()
    XCTAssertNotNil((listing["root"] as? [String: Any])?["error"])
  }

  func testTheFirstConflictStopsTheBatch() throws {
    let root = try folder("root")
    for (name, url) in [("A", "https://a.example/"), ("B", "https://b.example/"), ("C", "https://c.example/")] {
      try webloc(url).write(to: root.appendingPathComponent("\(name).webloc"), atomically: true, encoding: .utf8)
    }
    let result = try SharedFolderDirectory(root: root).apply(json: try ops([
      ["op": "move", "path": "A.webloc", "to": "B.webloc"],
      ["op": "move", "path": "C.webloc", "to": "A.webloc"],
    ]))
    XCTAssertEqual(result["conflicts"] as? [String], ["B.webloc"])
    XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent("C.webloc").path))
    XCTAssertTrue(try String(contentsOf: root.appendingPathComponent("A.webloc"), encoding: .utf8).contains("a.example"))
  }

  func testReadsStopAtTheCapWhateverSizeTheFileReported() throws {
    let root = try folder("root")
    let path = root.appendingPathComponent("Growing.webloc")
    let fifo = root.appendingPathComponent("Pipe.webloc")
    XCTAssertEqual(mkfifo(fifo.path, 0o644), 0)
    try webloc("https://small.example/").write(to: path, atomically: true, encoding: .utf8)
    let listing = SharedFolderDirectory(root: root).read()
    let kinds = Dictionary(uniqueKeysWithValues: entries(listing).map { ($0["file"] as! String, $0["kind"] as! String) })
    XCTAssertEqual(kinds["Growing.webloc"], "link")
    XCTAssertEqual(kinds["Pipe.webloc"], "pending")
    XCTAssertNil(SharedFolderDirectory.boundedRead(path.path, limit: 10))
    XCTAssertEqual(SharedFolderDirectory.boundedRead(path.path, limit: 4096).map { String(decoding: $0, as: UTF8.self).contains("small") }, true)
  }

  func testAFolderWithAnUnknownEntryKeepsItsOrderFile() throws {
    let root = try folder("root")
    let sub = try folder("root/Sub")
    try "{\"version\":1,\"order\":[\"Note.txt\"]}".write(to: sub.appendingPathComponent(".ardia-folder.json"), atomically: true, encoding: .utf8)
    try "keep".write(to: sub.appendingPathComponent("Note.txt"), atomically: true, encoding: .utf8)
    _ = try SharedFolderDirectory(root: root).apply(json: try ops([["op": "rmdir", "path": "Sub"]]))
    XCTAssertTrue(fm.fileExists(atPath: sub.appendingPathComponent(".ardia-folder.json").path))
    try fm.removeItem(at: sub.appendingPathComponent("Note.txt"))
    _ = try SharedFolderDirectory(root: root).apply(json: try ops([["op": "rmdir", "path": "Sub"]]))
    XCTAssertFalse(fm.fileExists(atPath: sub.path))
  }

  func testFolderNamesAreCappedByTheirUTF8Bytes() {
    XCTAssertLessThanOrEqual(SharedFolderDirectory.folderName(String(repeating: "界", count: 150)).utf8.count, 200)
    XCTAssertEqual(SharedFolderDirectory.folderName("a/b"), "a-b")
  }

  func testAFolderThatCantBeOpenedIsAnErrorNotMissing() throws {
    let parent = try folder("locked")
    let root = try folder("locked/Shared")
    chmod(parent.path, 0o000)
    defer { chmod(parent.path, 0o755) }
    let listing = SharedFolderDirectory(root: root).read()
    XCTAssertEqual(listing["exists"] as? Bool, false)
    XCTAssertNotNil(listing["error"] as? String)
    XCTAssertNil(SharedFolderDirectory(root: scratch.appendingPathComponent("nowhere")).read()["error"])
  }

  func testResolveGivesTheCanonicalPathAndRefusesTheRootAFileAndAMissingFolder() throws {
    let real = try folder("real")
    let link = scratch.appendingPathComponent("link")
    try fm.createSymbolicLink(at: link, withDestinationURL: real)
    let viaLink = try SharedFolderDirectory.resolve(link.path + "/")
    let direct = try SharedFolderDirectory.resolve(real.path)
    XCTAssertEqual(viaLink["path"] as? String, direct["path"] as? String)
    XCTAssertEqual(viaLink["inode"] as? Int, direct["inode"] as? Int)
    XCTAssertFalse((direct["path"] as! String).contains("/link"))
    XCTAssertThrowsError(try SharedFolderDirectory.resolve("/"))
    XCTAssertThrowsError(try SharedFolderDirectory.resolve(scratch.appendingPathComponent("nowhere").path))
    try "x".write(to: scratch.appendingPathComponent("plain.txt"), atomically: true, encoding: .utf8)
    XCTAssertThrowsError(try SharedFolderDirectory.resolve(scratch.appendingPathComponent("plain.txt").path))
  }

  func testARepointedSymlinkIsNeitherReadNorWritten() throws {
    let first = try folder("first")
    let second = try folder("second")
    try webloc("https://second.example/").write(to: second.appendingPathComponent("Other.webloc"), atomically: true, encoding: .utf8)
    let link = scratch.appendingPathComponent("bound")
    try fm.createSymbolicLink(at: link, withDestinationURL: first)
    let resolved = try SharedFolderDirectory.resolve(link.path)
    let identity = ["device": resolved["device"] as! Int, "inode": resolved["inode"] as! Int]
    let canonical = URL(fileURLWithPath: resolved["path"] as! String, isDirectory: true)
    XCTAssertEqual(SharedFolderDirectory(root: canonical, identity: identity).read()["exists"] as? Bool, true)

    try fm.removeItem(at: first)
    try fm.createSymbolicLink(at: URL(fileURLWithPath: resolved["path"] as! String), withDestinationURL: second)
    let moved = SharedFolderDirectory(root: canonical, identity: identity)
    XCTAssertEqual(moved.read()["exists"] as? Bool, false)
    XCTAssertNotNil(moved.read()["error"] as? String)
    XCTAssertThrowsError(try moved.apply(json: try ops([["op": "write", "path": "New.webloc", "text": webloc("https://x.example/"), "create": true, "expect": NSNull()]])))
    XCTAssertFalse(fm.fileExists(atPath: second.appendingPathComponent("New.webloc").path))
  }

  func testAFolderPastTheScanCapIsRefusedWithAClearError() throws {
    let root = try folder("big")
    for i in 0...SharedFolderDirectory.maxEntries { XCTAssertTrue(fm.createFile(atPath: root.appendingPathComponent("f\(i).txt").path, contents: nil)) }
    let listing = SharedFolderDirectory(root: root).read()
    XCTAssertEqual(listing["exists"] as? Bool, false)
    XCTAssertTrue((listing["error"] as? String)?.contains("more than") == true)
  }

  func testRemovingAFolderThatCantBeOpenedIsAnErrorNotDone() throws {
    let root = try folder("root")
    let locked = try folder("root/Locked")
    try fm.setAttributes([.posixPermissions: 0o000], ofItemAtPath: locked.path)
    defer { try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: locked.path) }
    XCTAssertThrowsError(try SharedFolderDirectory(root: root).apply(json: try ops([["op": "rmdir", "path": "Locked"]])))
    XCTAssertTrue(fm.fileExists(atPath: locked.path))
  }
}
