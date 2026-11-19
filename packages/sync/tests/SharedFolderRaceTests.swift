import Foundation
import XCTest
@testable import ArdiaSyncCore

final class SharedFolderRaceTests: XCTestCase {
  private var scratch: URL!
  private let fm = FileManager.default

  override func setUpWithError() throws {
    scratch = fm.temporaryDirectory.appendingPathComponent("shared-folder-race-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: scratch, withIntermediateDirectories: true)
    scratch = URL(fileURLWithPath: SharedFolderDirectory.realPath(scratch.path)!, isDirectory: true)
  }

  override func tearDownWithError() throws {
    SharedFolderDirectory.pausePoint = nil
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

  private func bound(_ url: URL) throws -> SharedFolderDirectory {
    let resolved = try SharedFolderDirectory.resolve(url.path)
    let identity = ["device": resolved["device"] as! Int, "inode": resolved["inode"] as! Int]
    return SharedFolderDirectory(root: URL(fileURLWithPath: resolved["path"] as! String, isDirectory: true), identity: identity)
  }

  private func swapForLink(_ url: URL, to target: URL) {
    let aside = url.deletingLastPathComponent().appendingPathComponent(url.lastPathComponent + "-moved")
    XCTAssertNoThrow(try fm.moveItem(at: url, to: aside))
    XCTAssertNoThrow(try fm.createSymbolicLink(at: url, withDestinationURL: target))
  }

  private func swapForImpostor(_ url: URL) {
    XCTAssertNoThrow(try fm.moveItem(at: url, to: url.deletingLastPathComponent().appendingPathComponent(url.lastPathComponent + "-moved")))
    XCTAssertNoThrow(try fm.createDirectory(at: url, withIntermediateDirectories: false))
  }

  private func outsideWithSecret() throws -> URL {
    let outside = try folder("outside")
    try webloc("https://outside.example/").write(to: outside.appendingPathComponent("Secret.webloc"), atomically: true, encoding: .utf8)
    return outside
  }

  func testARootReplacedAfterItsCheckIsNeverScanned() throws {
    let outside = try outsideWithSecret()
    let root = try folder("root")
    try webloc("https://mine.example/").write(to: root.appendingPathComponent("Mine.webloc"), atomically: true, encoding: .utf8)
    let directory = try bound(root)
    SharedFolderDirectory.pausePoint = { point in if point == "root" { self.swapForLink(root, to: outside) } }
    let listing = String(describing: directory.read())
    XCTAssertFalse(listing.contains("outside.example"))
  }

  func testADescendantReplacedMidScanIsNeverFollowed() throws {
    let outside = try outsideWithSecret()
    let root = try folder("root")
    let sub = try folder("root/Sub")
    try webloc("https://mine.example/").write(to: sub.appendingPathComponent("Mine.webloc"), atomically: true, encoding: .utf8)
    let directory = try bound(root)
    SharedFolderDirectory.pausePoint = { point in if point == "scan:Sub" { self.swapForLink(sub, to: outside) } }
    let listing = String(describing: directory.read())
    XCTAssertFalse(listing.contains("outside.example"))
  }

  func testARootReplacedBeforeAWriteIsNeverWrittenThrough() throws {
    let outside = try outsideWithSecret()
    let root = try folder("root")
    let directory = try bound(root)
    SharedFolderDirectory.pausePoint = { point in if point == "op:New.webloc" { self.swapForImpostor(root) } }
    let result = try? directory.apply(json: try ops([["op": "write", "path": "New.webloc", "text": webloc("https://new.example/"), "create": true, "expect": NSNull()]]))
    XCTAssertFalse(fm.fileExists(atPath: outside.appendingPathComponent("New.webloc").path))
    XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("New.webloc").path), "the impostor at the bound path stays untouched")
    XCTAssertFalse(fm.fileExists(atPath: scratch.appendingPathComponent("root-moved/New.webloc").path), "a folder its path no longer names isn't written either")
    XCTAssertEqual(result?["conflicts"] as? [String], ["New.webloc"])
  }

  func testADescendantReplacedBeforeAWriteOrDeleteIsNeverTouched() throws {
    let outside = try outsideWithSecret()
    let root = try folder("root")
    let sub = try folder("root/Sub")
    try webloc("https://outside.example/").write(to: sub.appendingPathComponent("Secret.webloc"), atomically: true, encoding: .utf8)
    let directory = try bound(root)
    SharedFolderDirectory.pausePoint = { point in if point.hasPrefix("op:Sub/") { self.swapForLink(sub, to: outside) } }
    _ = try? directory.apply(json: try ops([["op": "write", "path": "Sub/New.webloc", "text": webloc("https://new.example/"), "create": true, "expect": NSNull()]]))
    XCTAssertFalse(fm.fileExists(atPath: outside.appendingPathComponent("New.webloc").path))

    try fm.removeItem(at: sub)
    try fm.moveItem(at: scratch.appendingPathComponent("root/Sub-moved"), to: sub)
    _ = try? directory.apply(json: try ops([["op": "delete", "path": "Sub/Secret.webloc", "expect": "https://outside.example/"]]))
    XCTAssertTrue(fm.fileExists(atPath: outside.appendingPathComponent("Secret.webloc").path))

    try fm.removeItem(at: sub)
    try fm.moveItem(at: scratch.appendingPathComponent("root/Sub-moved"), to: sub)
    try fm.createDirectory(at: outside.appendingPathComponent("Made"), withIntermediateDirectories: false)
    _ = try? directory.apply(json: try ops([["op": "mkdir", "path": "Sub/Other"]]))
    XCTAssertFalse(fm.fileExists(atPath: outside.appendingPathComponent("Other").path))
  }

  func testCreateReturnsTheNewFoldersIdentityAndDiscardOnlyRemovesThatFolder() throws {
    let parent = try folder("parent")
    let made = try SharedFolderDirectory.create(inParent: parent.path, parentIdentity: nil, named: "Team")
    let path = made["path"] as! String
    XCTAssertEqual(path, parent.appendingPathComponent("Team").path)
    let identity = ["device": made["device"] as! Int, "inode": made["inode"] as! Int]
    XCTAssertEqual(SharedFolderDirectory.identity(of: path), identity)

    try fm.removeItem(atPath: path)
    try fm.createDirectory(atPath: path, withIntermediateDirectories: false)
    XCTAssertFalse(SharedFolderDirectory.discard(path, identity: identity))
    XCTAssertTrue(fm.fileExists(atPath: path))

    let again = try SharedFolderDirectory.create(inParent: parent.path, parentIdentity: nil, named: "Team")
    let againIdentity = ["device": again["device"] as! Int, "inode": again["inode"] as! Int]
    XCTAssertTrue(SharedFolderDirectory.discard(again["path"] as! String, identity: againIdentity))
    XCTAssertFalse(fm.fileExists(atPath: again["path"] as! String))
  }

  func testAnExplicitParentIsNeverRecreatedOrSwapped() throws {
    let parent = try folder("parent")
    let other = try folder("other")
    let resolved = try SharedFolderDirectory.resolve(parent.path)
    let identity = ["device": resolved["device"] as! Int, "inode": resolved["inode"] as! Int]
    try fm.removeItem(at: parent)
    XCTAssertThrowsError(try SharedFolderDirectory.create(inParent: parent.path, parentIdentity: identity, named: "Team"))
    XCTAssertFalse(fm.fileExists(atPath: parent.path))
    try fm.createSymbolicLink(at: parent, withDestinationURL: other)
    XCTAssertThrowsError(try SharedFolderDirectory.create(inParent: parent.path, parentIdentity: identity, named: "Team"))
    XCTAssertFalse(fm.fileExists(atPath: other.appendingPathComponent("Team").path))
  }

  func testManifestBytesCountTowardTheScanCap() throws {
    let root = try folder("root")
    let manifest = Data(repeating: 0x20, count: SharedFolderDirectory.maxManifestBytes - 16)
    for i in 0...(SharedFolderDirectory.maxScanBytes / manifest.count) {
      let sub = try folder("root/D\(i)")
      fm.createFile(atPath: sub.appendingPathComponent(SharedFolderDirectory.manifestName).path, contents: manifest)
    }
    let listing = SharedFolderDirectory(root: root).read()
    XCTAssertEqual(listing["exists"] as? Bool, false)
    XCTAssertTrue((listing["error"] as? String)?.contains("more than") == true)
  }

  func testResolveRefusesTheRootSystemAndHomeFoldersAsRefusals() {
    for path in ["/", "/System", "/Users", NSHomeDirectory()] {
      XCTAssertThrowsError(try SharedFolderDirectory.resolve(path)) { error in
        XCTAssertTrue(error is SharedFolderDirectory.Refused, "\(path): \(error)")
      }
    }
  }

  func testDataVolumeAliasesOfSystemAndHomeFoldersAreRefused() {
    for path in ["/System/Volumes/Data", "/System/Volumes/Data/Users", "/System/Volumes/Data" + NSHomeDirectory()] where FileManager.default.fileExists(atPath: path) {
      XCTAssertThrowsError(try SharedFolderDirectory.resolve(path)) { error in
        XCTAssertTrue(error is SharedFolderDirectory.Refused, "\(path): \(error)")
      }
    }
  }

  func testNamesWithControlCharactersAreSanitizedAndCreateFinishes() throws {
    let parent = try folder("parent")
    XCTAssertEqual(SharedFolderDirectory.folderName("Team\u{0}One\u{7}/Two:Three"), "Team-One--Two-Three")
    let made = try SharedFolderDirectory.create(inParent: parent.path, parentIdentity: nil, named: "Team\u{0}One")
    XCTAssertEqual(made["path"] as? String, parent.appendingPathComponent("Team-One").path)
    let again = try SharedFolderDirectory.create(inParent: parent.path, parentIdentity: nil, named: "Team\u{0}One")
    XCTAssertEqual(again["path"] as? String, parent.appendingPathComponent("Team-One 2").path)
  }

  func testCreateRefusesAFolderSwappedRightAfterItWasMade() throws {
    let parent = try folder("parent")
    SharedFolderDirectory.pausePoint = { point in if point == "create:Team" { self.swapForImpostor(parent.appendingPathComponent("Team")) } }
    XCTAssertThrowsError(try SharedFolderDirectory.create(inParent: parent.path, parentIdentity: nil, named: "Team"))
  }

  func testRemovingAnEmptiedFolderNeverRemovesItsReplacement() throws {
    let root = try folder("root")
    let sub = try folder("root/Sub")
    let directory = try bound(root)
    SharedFolderDirectory.pausePoint = { point in if point == "rmdir:Sub" { self.swapForImpostor(sub) } }
    _ = try directory.apply(json: try ops([["op": "rmdir", "path": "Sub"]]))
    XCTAssertTrue(fm.fileExists(atPath: sub.path), "the replacement stays")
    XCTAssertEqual(try fm.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix(".ardia-removing") }, [])
  }

  func testDiscardNeverRemovesAReplacement() throws {
    let parent = try folder("parent")
    let made = try SharedFolderDirectory.create(inParent: parent.path, parentIdentity: nil, named: "Team")
    let identity = ["device": made["device"] as! Int, "inode": made["inode"] as! Int]
    swapForImpostor(URL(fileURLWithPath: made["path"] as! String))
    XCTAssertFalse(SharedFolderDirectory.discard(made["path"] as! String, identity: identity))
    XCTAssertTrue(fm.fileExists(atPath: made["path"] as! String))
  }

  func testARenameNeverMovesAReplacedSource() throws {
    let root = try folder("root")
    let source = root.appendingPathComponent("A.webloc")
    try webloc("https://mine.example/").write(to: source, atomically: true, encoding: .utf8)
    let directory = try bound(root)
    SharedFolderDirectory.pausePoint = { point in
      guard point == "move:A.webloc" else { return }
      try? self.fm.removeItem(at: source)
      try? self.webloc("https://replacement.example/").write(to: source, atomically: true, encoding: .utf8)
    }
    let result = try directory.apply(json: try ops([["op": "move", "path": "A.webloc", "to": "B.webloc"]]))
    XCTAssertEqual(result["conflicts"] as? [String], ["B.webloc"])
    XCTAssertTrue(try String(contentsOf: source, encoding: .utf8).contains("replacement.example"))
    XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("B.webloc").path))
  }

  func testASubfolderWhosePathMovedIsAnErrorNotARead() throws {
    let root = try folder("root")
    let sub = try folder("root/Sub")
    try webloc("https://mine.example/").write(to: sub.appendingPathComponent("Mine.webloc"), atomically: true, encoding: .utf8)
    let directory = try bound(root)
    SharedFolderDirectory.pausePoint = { point in if point == "scan:Sub" { self.swapForImpostor(sub) } }
    let listing = String(describing: directory.read())
    XCTAssertTrue(listing.contains("moved while Ardia read it"), listing)
    XCTAssertFalse(listing.contains("mine.example"))
  }

  func testUndecodableBytesCountTowardTheScanCap() throws {
    let root = try folder("root")
    let manifest = Data(repeating: 0xFF, count: SharedFolderDirectory.maxManifestBytes - 16)
    for i in 0...(SharedFolderDirectory.maxScanBytes / manifest.count) {
      let sub = try folder("root/D\(i)")
      fm.createFile(atPath: sub.appendingPathComponent(SharedFolderDirectory.manifestName).path, contents: manifest)
    }
    let listing = try bound(root).read()
    XCTAssertEqual(listing["exists"] as? Bool, false)
    XCTAssertTrue((listing["error"] as? String)?.contains("more than") == true)
  }
}
