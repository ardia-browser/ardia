import Foundation
import XCTest
@testable import ArdiaSyncCore

private final class HoldingPresenter: NSObject, NSFilePresenter {
  let presentedItemURL: URL?
  let presentedItemOperationQueue = OperationQueue()

  init(_ url: URL) {
    presentedItemURL = url
  }

  func relinquishPresentedItem(toReader reader: @escaping ((() -> Void)?) -> Void) {}
  func relinquishPresentedItem(toWriter writer: @escaping ((() -> Void)?) -> Void) {}
}

final class SharedFolderChangeTests: XCTestCase {
  private var scratch: URL!
  private let fm = FileManager.default

  override func setUpWithError() throws {
    scratch = fm.temporaryDirectory.appendingPathComponent("shared-folder-changes-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: scratch, withIntermediateDirectories: true)
    scratch = URL(fileURLWithPath: SharedFolderDirectory.realPath(scratch.path)!, isDirectory: true)
  }

  override func tearDownWithError() throws {
    SharedFolderDirectory.pausePoint = nil
    SharedFolderDirectory.scanSeconds = 30
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

  private func bound(_ url: URL, coordination: SyncCoordination? = SharedFolderDirectory.coordination, cancelled: @escaping () -> Bool = { false }) throws -> SharedFolderDirectory {
    let identity = SharedFolderDirectory.identity(of: url.path)!
    return SharedFolderDirectory(root: url, identity: identity, coordination: coordination, cancelled: cancelled)
  }

  func testACancelledBatchStopsBeforeItsNextOperation() throws {
    let root = try folder("root")
    var calls = 0
    let directory = try bound(root) {
      calls += 1
      return calls > 1
    }
    let result = try directory.apply(json: try ops([
      ["op": "write", "path": "A.webloc", "text": webloc("https://a.example/"), "create": true, "expect": NSNull()],
      ["op": "write", "path": "B.webloc", "text": webloc("https://b.example/"), "create": true, "expect": NSNull()],
    ]))
    XCTAssertEqual(result["cancelled"] as? Bool, true)
    XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("A.webloc").path), "the cancel after the coordination wait stopped the first write")
    XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("B.webloc").path))
  }

  func testMkdirOntoAnExistingFolderIsAConflictAndAMovedParentGetsNothing() throws {
    let root = try folder("root")
    _ = try folder("root/Existing")
    let directory = try bound(root)
    XCTAssertEqual(try directory.apply(json: try ops([["op": "mkdir", "path": "Existing"]]))["conflicts"] as? [String], ["Existing"])
    let parent = try folder("root/Parent")
    SharedFolderDirectory.pausePoint = { point in
      if point == "op:Parent/New" { try? self.fm.moveItem(at: parent, to: self.scratch.appendingPathComponent("Parent-moved")) }
    }
    _ = try directory.apply(json: try ops([["op": "mkdir", "path": "Parent/New"]]))
    XCTAssertFalse(fm.fileExists(atPath: scratch.appendingPathComponent("Parent-moved/New").path), "nothing was made in the moved folder")
  }

  func testRmdirInAMovedFolderRemovesNothing() throws {
    let root = try folder("root")
    let parent = try folder("root/Parent")
    _ = try folder("root/Parent/Empty")
    try "{}".write(to: parent.appendingPathComponent("Empty/.ardia-folder.json"), atomically: true, encoding: .utf8)
    let directory = try bound(root)
    let moved = scratch.appendingPathComponent("Parent-moved")
    SharedFolderDirectory.pausePoint = { point in if point == "op:Parent/Empty" { try? self.fm.moveItem(at: parent, to: moved) } }
    _ = try directory.apply(json: try ops([["op": "rmdir", "path": "Parent/Empty"]]))
    XCTAssertTrue(fm.fileExists(atPath: moved.appendingPathComponent("Empty/.ardia-folder.json").path), "the moved folder and its order file stay")
  }

  func testRmdirOfAReplacedFolderLeavesTheReplacementAndItsFilesAlone() throws {
    let root = try folder("root")
    let sub = try folder("root/Sub")
    let directory = try bound(root)
    SharedFolderDirectory.pausePoint = { point in
      guard point == "rmdir:Sub" else { return }
      try? self.fm.moveItem(at: sub, to: self.scratch.appendingPathComponent("Sub-moved"))
      try? self.fm.createDirectory(at: sub, withIntermediateDirectories: false)
      try? "{\"theirs\":true}".write(to: sub.appendingPathComponent(".ardia-folder.json"), atomically: true, encoding: .utf8)
    }
    _ = try directory.apply(json: try ops([["op": "rmdir", "path": "Sub"]]))
    XCTAssertTrue(try String(contentsOf: sub.appendingPathComponent(".ardia-folder.json"), encoding: .utf8).contains("theirs"))
    XCTAssertEqual(try fm.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix(".ardia-removing") }, [])
  }

  func testReplacingALinkNeverOverwritesAFileSwappedInJustBefore() throws {
    let root = try folder("root")
    let link = root.appendingPathComponent("A.webloc")
    try webloc("https://old.example/").write(to: link, atomically: true, encoding: .utf8)
    let directory = try bound(root)
    SharedFolderDirectory.pausePoint = { point in
      guard point == "swap:A.webloc" else { return }
      try? self.fm.removeItem(at: link)
      try? self.webloc("https://theirs.example/").write(to: link, atomically: true, encoding: .utf8)
    }
    let result = try directory.apply(json: try ops([["op": "write", "path": "A.webloc", "text": webloc("https://new.example/"), "create": false, "expect": "https://old.example/"]]))
    XCTAssertEqual(result["conflicts"] as? [String], ["A.webloc"])
    XCTAssertTrue(try String(contentsOf: link, encoding: .utf8).contains("theirs.example"))
  }

  func testDeletingALinkNeverRemovesAFileSwappedInJustBefore() throws {
    let root = try folder("root")
    let link = root.appendingPathComponent("A.webloc")
    try webloc("https://old.example/").write(to: link, atomically: true, encoding: .utf8)
    let directory = try bound(root)
    SharedFolderDirectory.pausePoint = { point in
      guard point == "unlink:A.webloc" else { return }
      try? self.fm.removeItem(at: link)
      try? self.webloc("https://theirs.example/").write(to: link, atomically: true, encoding: .utf8)
    }
    _ = try directory.apply(json: try ops([["op": "delete", "path": "A.webloc", "expect": "https://old.example/"]]))
    XCTAssertTrue(try String(contentsOf: link, encoding: .utf8).contains("theirs.example"))
    XCTAssertEqual(try fm.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix(".ardia-removing") }, [])
  }

  func testABinaryLinkThatGrowsPastTheCapAsXMLIsHeld() throws {
    let root = try folder("root")
    let plist = ["URL": "https://a.example/?" + String(repeating: "&", count: 40_000)]
    let binary = try PropertyListSerialization.data(fromPropertyList: plist, format: .binary, options: 0)
    XCTAssertLessThan(binary.count, SharedFolderDirectory.maxLinkBytes)
    fm.createFile(atPath: root.appendingPathComponent("Big.webloc").path, contents: binary)
    let listing = try bound(root).read()
    let entries = ((listing["root"] as? [String: Any])?["entries"] as? [[String: Any]]) ?? []
    XCTAssertEqual(entries.first?["kind"] as? String, "pending", "\(entries)")
  }

  func testAScanPastItsDeadlineIsAnError() throws {
    let root = try folder("root")
    try webloc("https://a.example/").write(to: root.appendingPathComponent("A.webloc"), atomically: true, encoding: .utf8)
    SharedFolderDirectory.scanSeconds = -1
    let listing = try bound(root).read()
    XCTAssertTrue((listing["error"] as? String)?.contains("took longer") == true, "\(listing)")
  }

  func testACoordinationTimeoutWhileScanningIsAnErrorNotAMissingLink() throws {
    let root = try folder("root")
    let stuck = root.appendingPathComponent("Stuck.webloc")
    try webloc("https://stuck.example/").write(to: stuck, atomically: true, encoding: .utf8)
    let presenter = HoldingPresenter(stuck)
    NSFileCoordinator.addFilePresenter(presenter)
    defer { NSFileCoordinator.removeFilePresenter(presenter) }
    let listing = try bound(root, coordination: SyncCoordination(timeout: 0.5)).read()
    XCTAssertTrue((listing["error"] as? String)?.contains("didn’t answer in time") == true, "\(listing)")
  }
}
