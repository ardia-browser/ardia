import XCTest

@testable import ArdiaPluginCore

final class PluginStorageTests: XCTestCase {
  var root = ""
  var folder: OpenedFolder!

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-storage-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = PluginSandbox.resolved(made.path)!
    folder = try XCTUnwrap(PluginFiles.openDataFolder(root))
  }

  override func tearDownWithError() throws {
    folder?.close()
    try? FileManager.default.removeItem(atPath: root)
  }

  var storagePath: String { "\(root)/\(PluginStorage.fileName)" }

  func testNothingSavedReadsAsMissing() throws {
    XCTAssertEqual(PluginStorage.read(in: folder.fd), .missing)
    XCTAssertEqual(PluginStorage.read(in: folder.fd).reply as NSDictionary, ["status": "missing"] as NSDictionary)
  }

  func testEachOutcomeHasItsOwnTaggedReply() throws {
    XCTAssertNil(PluginStorage.write(in: folder.fd, text: "[1]"))
    XCTAssertEqual(PluginStorage.read(in: folder.fd).reply as NSDictionary, ["status": "ok", "text": "[1]"] as NSDictionary)
    XCTAssertEqual(PluginStorageRead.error("x").reply as NSDictionary, ["status": "error", "reason": "x"] as NSDictionary)
  }

  func testInvalidUTF8IsAnErrorNotMissing() throws {
    try Data([0x22, 0xff, 0xfe, 0x22]).write(to: URL(fileURLWithPath: storagePath))
    XCTAssertEqual(PluginStorage.read(in: folder.fd), .error("its storage isn't UTF-8"))
  }

  func testAWriteReadsBackAndIsPrivateToTheUser() throws {
    XCTAssertNil(PluginStorage.write(in: folder.fd, text: #"{"a":1,"b":"ü"}"#))
    XCTAssertEqual(PluginStorage.read(in: folder.fd), .ok(#"{"a":1,"b":"ü"}"#))
    var info = stat()
    XCTAssertEqual(lstat(storagePath, &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o600)
  }

  func testAWriteReplacesTheFileAtomicallyAndLeavesNoTemporaryFiles() throws {
    XCTAssertNil(PluginStorage.write(in: folder.fd, text: #"{"v":1}"#))
    var before = stat()
    XCTAssertEqual(lstat(storagePath, &before), 0)
    XCTAssertNil(PluginStorage.write(in: folder.fd, text: #"{"v":2}"#))
    var after = stat()
    XCTAssertEqual(lstat(storagePath, &after), 0)
    XCTAssertNotEqual(before.st_ino, after.st_ino, "a rename, not a rewrite in place")
    XCTAssertEqual(PluginStorage.read(in: folder.fd), .ok(#"{"v":2}"#))
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: root).filter { $0.hasPrefix(".storage.json.") }
    XCTAssertEqual(leftovers, [])
  }

  func testALinkedStorageFileIsRefusedForReadingAndWriting() throws {
    let outside = "\(root)/home/secret.json"
    try #"{"secret":true}"#.write(toFile: outside, atomically: false, encoding: .utf8)
    XCTAssertEqual(symlink(outside, storagePath), 0)
    XCTAssertEqual(PluginStorage.read(in: folder.fd), .error("its storage is a link"))
    XCTAssertNotNil(PluginStorage.write(in: folder.fd, text: "{}"))
    XCTAssertEqual(try String(contentsOfFile: outside, encoding: .utf8), #"{"secret":true}"#)
  }

  func testAFolderOrFifoInItsPlaceIsRefused() throws {
    XCTAssertEqual(mkfifo(storagePath, 0o600), 0)
    XCTAssertEqual(PluginStorage.read(in: folder.fd), .error("its storage isn't a file"))
    XCTAssertNotNil(PluginStorage.write(in: folder.fd, text: "{}"))
  }

  func testStorageOverTheCapIsRefusedBothWays() throws {
    let big = "\"" + String(repeating: "a", count: PluginStorage.limit) + "\""
    XCTAssertNotNil(PluginStorage.write(in: folder.fd, text: big))
    XCTAssertEqual(PluginStorage.read(in: folder.fd), .missing)
    try big.write(toFile: storagePath, atomically: false, encoding: .utf8)
    XCTAssertEqual(PluginStorage.read(in: folder.fd), .error("its storage is over 2 MB"))
  }

  func testOnlyJSONIsSaved() {
    XCTAssertNotNil(PluginStorage.write(in: folder.fd, text: "not json"))
    XCTAssertNil(PluginStorage.write(in: folder.fd, text: "[]"))
  }

  func testAScriptEntryMustBeARegularFileInsideTheFolderWithoutLinks() throws {
    let plugin = try XCTUnwrap(PluginFiles.openFolder(root))
    defer { plugin.close() }
    try FileManager.default.createDirectory(atPath: "\(root)/dist", withIntermediateDirectories: true)
    try "1".write(toFile: "\(root)/dist/main.js", atomically: false, encoding: .utf8)
    XCTAssertEqual(PluginFiles.scriptEntry("dist/main.js", in: plugin), "dist/main.js")
    XCTAssertNil(PluginFiles.scriptEntry("../main.js", in: plugin))
    XCTAssertNil(PluginFiles.scriptEntry("/etc/hosts", in: plugin))
    XCTAssertNil(PluginFiles.scriptEntry("dist", in: plugin))
    XCTAssertNil(PluginFiles.scriptEntry("dist/missing.js", in: plugin))
    XCTAssertEqual(symlink("\(root)/dist", "\(root)/linked"), 0)
    XCTAssertNil(PluginFiles.scriptEntry("linked/main.js", in: plugin))
    XCTAssertEqual(symlink("\(root)/dist/main.js", "\(root)/entry.js"), 0)
    XCTAssertNil(PluginFiles.scriptEntry("entry.js", in: plugin))
  }

  func testPluginTextIsReadOnlyFromRegularFilesUnderTheCap() throws {
    let plugin = try XCTUnwrap(PluginFiles.openFolder(root))
    defer { plugin.close() }
    try ":root{--a:1}".write(toFile: "\(root)/theme.css", atomically: false, encoding: .utf8)
    XCTAssertEqual(try PluginFiles.readText("theme.css", in: plugin).get(), ":root{--a:1}")
    XCTAssertEqual(symlink("\(root)/theme.css", "\(root)/link.css"), 0)
    guard case .failure = PluginFiles.readText("link.css", in: plugin) else { return XCTFail("a link was followed") }
    guard case .failure = PluginFiles.readText("../theme.css", in: plugin) else { return XCTFail("a traversal was followed") }
    try String(repeating: "a", count: PluginFiles.maxPluginText + 1).write(toFile: "\(root)/big.css", atomically: false, encoding: .utf8)
    guard case .failure = PluginFiles.readText("big.css", in: plugin) else { return XCTFail("an oversized file was read") }
  }
}
