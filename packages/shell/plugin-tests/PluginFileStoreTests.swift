import XCTest

@testable import ArdiaPluginCore

final class PluginFileStoreTests: XCTestCase {
  var base = ""
  var root: String { "\(base)/files" }
  var store: PluginFileStore!
  var quota: PluginFileQuota!

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-files-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    base = PluginFileStore.realPath(made.path)!
    quota = PluginFileQuota()
    store = PluginFileStore(root: root, isData: true, quota: quota)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: base)
  }

  func b64(_ text: String) -> String { Data(text.utf8).base64EncodedString() }

  func call(_ spec: [String: Any], on given: PluginFileStore? = nil) -> [String: Any] { (given ?? store).perform(spec) }

  func write(_ path: String, _ text: String, exclusive: Bool = false, on given: PluginFileStore? = nil) -> [String: Any] {
    call(["op": "write", "path": path, "data": b64(text), "exclusive": exclusive], on: given)
  }

  func code(_ reply: [String: Any]) -> String? { reply["ok"] as? Bool == false ? reply["code"] as? String : nil }

  func text(_ path: String, on given: PluginFileStore? = nil) -> String? {
    let reply = call(["op": "read", "path": path], on: given)
    guard reply["found"] as? Bool == true, let data = (reply["data"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return nil }
    return String(decoding: data, as: UTF8.self)
  }

  func paths(_ reply: [String: Any]) -> [String] { (reply["entries"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String } }

  func testWriteThenReadMakesParentsPrivate() throws {
    let reply = write("a/b/c.txt", "hello")
    XCTAssertEqual(reply["ok"] as? Bool, true)
    XCTAssertEqual(reply["size"] as? Int64, 5)
    XCTAssertNotNil(reply["mtimeMs"] as? Int64)
    XCTAssertEqual(text("a/b/c.txt"), "hello")
    let mode = try FileManager.default.attributesOfItem(atPath: "\(root)/a")[.posixPermissions] as? Int
    XCTAssertEqual(mode, 0o700)
    let rootMode = try FileManager.default.attributesOfItem(atPath: root)[.posixPermissions] as? Int
    XCTAssertEqual(rootMode, 0o700)
  }

  func testMissingFileReadsAsNotFound() {
    XCTAssertEqual(call(["op": "read", "path": "nope.txt"])["found"] as? Bool, false)
    XCTAssertEqual(call(["op": "read", "path": "no/such/dir.txt"])["found"] as? Bool, false)
  }

  func testPathsThatLeaveTheRootAreRefused() {
    let long = String(repeating: "x", count: 256)
    let deep = Array(repeating: "abcdefghij", count: 100).joined(separator: "/")
    for path in ["../x", "a/../../x", "/etc/passwd", "a//b", "a/./b", "", "a\u{0}b", "a\nb", "a\u{7f}", long, deep, "x/", ".a.ardia-\(UUID().uuidString)"] {
      XCTAssertEqual(code(write(path, "x")), "bad_path", path)
      XCTAssertEqual(code(call(["op": "read", "path": path])), "bad_path", path)
    }
    XCTAssertEqual(code(call(["op": "remove", "path": "../x"])), "bad_path")
    XCTAssertEqual(code(call(["op": "list", "path": "../"])), "bad_path")
    XCTAssertEqual(write(String(repeating: "y", count: 255), "ok")["ok"] as? Bool, true)
  }

  func testSymlinkedFileIsRefusedAndOutsideUntouched() throws {
    let outside = "\(base)/outside.txt"
    try "secret".write(toFile: outside, atomically: true, encoding: .utf8)
    _ = call(["op": "list", "path": ""])
    try FileManager.default.createSymbolicLink(atPath: "\(root)/link.txt", withDestinationPath: outside)
    XCTAssertEqual(code(call(["op": "read", "path": "link.txt"])), "refused")
    XCTAssertEqual(code(write("link.txt", "x")), "refused")
    XCTAssertEqual(code(call(["op": "append", "path": "link.txt", "data": b64("x")])), "refused")
    XCTAssertEqual(code(call(["op": "remove", "path": "link.txt"])), "refused")
    XCTAssertEqual(try String(contentsOfFile: outside, encoding: .utf8), "secret")
  }

  func testSymlinkedDirectoryInTheMiddleIsRefused() throws {
    let outside = "\(base)/elsewhere"
    try FileManager.default.createDirectory(atPath: outside, withIntermediateDirectories: true)
    try "secret".write(toFile: "\(outside)/f.txt", atomically: true, encoding: .utf8)
    XCTAssertEqual(write("a/x.txt", "x")["ok"] as? Bool, true)
    try FileManager.default.createSymbolicLink(atPath: "\(root)/a/mid", withDestinationPath: outside)
    XCTAssertEqual(code(call(["op": "read", "path": "a/mid/f.txt"])), "refused")
    XCTAssertEqual(code(write("a/mid/g.txt", "x")), "refused")
    XCTAssertEqual(code(call(["op": "list", "path": "a/mid"])), "refused")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(outside)/g.txt"))
  }

  func testGrantRootSwappedForALinkIsRefused() throws {
    let grant = "\(base)/grant"
    let other = "\(base)/other"
    try FileManager.default.createDirectory(atPath: grant, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: other, withIntermediateDirectories: true)
    let granted = PluginFileStore(root: grant, isData: false)
    XCTAssertEqual(write("n.md", "x", on: granted)["ok"] as? Bool, true)
    let mode = try FileManager.default.attributesOfItem(atPath: "\(grant)/n.md")[.posixPermissions] as? Int
    XCTAssertEqual(mode, 0o644)
    try FileManager.default.removeItem(atPath: grant)
    XCTAssertEqual(code(write("n.md", "x", on: granted)), "unavailable")
    XCTAssertEqual(call(["op": "stat", "path": ""], on: granted)["found"] as? Bool, false)
    try FileManager.default.createSymbolicLink(atPath: grant, withDestinationPath: other)
    XCTAssertEqual(code(write("n.md", "x", on: granted)), "refused")
    XCTAssertEqual(code(call(["op": "list", "path": ""], on: granted)), "refused")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(other)/n.md"))
  }

  func testGrantRootUnderALinkedParentIsRefused() throws {
    let real = "\(base)/real"
    try FileManager.default.createDirectory(atPath: "\(real)/inner", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: "\(base)/alias", withDestinationPath: real)
    let granted = PluginFileStore(root: "\(base)/alias/inner", isData: false)
    XCTAssertEqual(code(write("n.md", "x", on: granted)), "refused")
  }

  func testExclusiveWriteAnswersExists() {
    XCTAssertEqual(write("n.md", "first", exclusive: true)["ok"] as? Bool, true)
    XCTAssertEqual(code(write("n.md", "second", exclusive: true)), "exists")
    XCTAssertEqual(text("n.md"), "first")
    XCTAssertEqual(write("n.md", "third")["ok"] as? Bool, true)
    XCTAssertEqual(text("n.md"), "third")
  }

  func testAtomicReplaceLeavesNoTemporaryFiles() throws {
    for index in 0..<20 { _ = write("d/n.md", "v\(index)") }
    _ = write("d/n.md", "x", exclusive: true)
    let names = try FileManager.default.contentsOfDirectory(atPath: "\(root)/d")
    XCTAssertEqual(names, ["n.md"])
    XCTAssertEqual(text("d/n.md"), "v19")
  }

  func testTemporaryNamesStayWithinASegment() {
    let name = String(repeating: "é", count: 127)
    let temporary = PluginFileStore.temporaryName(for: name)
    XCTAssertLessThanOrEqual(temporary.utf8.count, 255)
    XCTAssertTrue(PluginFileStore.isTemporary(temporary))
    XCTAssertFalse(PluginFileStore.isTemporary(".notes.ardia-backup"))
    XCTAssertEqual(write(name, "x")["ok"] as? Bool, true)
  }

  func testAppendKeepsOrderAndMakesParents() {
    for index in 0..<10 {
      let reply = call(["op": "append", "path": "log/2026/day.jsonl", "data": b64("\(index)\n")])
      XCTAssertEqual(reply["ok"] as? Bool, true)
    }
    XCTAssertEqual(text("log/2026/day.jsonl"), (0..<10).map { "\($0)\n" }.joined())
    XCTAssertEqual(call(["op": "append", "path": "log/2026/day.jsonl", "data": b64("")])["size"] as? Int64, 20)
  }

  func testListShowsFilesAndFoldersSortedAndHidesLinksAndTemporaries() throws {
    _ = write("b.md", "bb")
    _ = write("a/z.md", "z")
    _ = write("a/deeper/y.md", "y")
    try FileManager.default.createSymbolicLink(atPath: "\(root)/link", withDestinationPath: "/etc")
    FileManager.default.createFile(atPath: "\(root)/.b.md.ardia-\(UUID().uuidString)", contents: Data("tmp".utf8))
    XCTAssertEqual(mkfifo("\(root)/pipe", 0o600), 0)
    let top = call(["op": "list", "path": ""])
    XCTAssertEqual(paths(top), ["a", "b.md"])
    let file = (top["entries"] as! [[String: Any]])[1]
    XCTAssertEqual(file["kind"] as? String, "file")
    XCTAssertEqual(file["size"] as? Int64, 2)
    XCTAssertEqual(file["placeholder"] as? Bool, false)
    XCTAssertEqual(paths(call(["op": "list"])), ["a", "b.md"])
    XCTAssertEqual(paths(call(["op": "list", "path": "", "recursive": true])), ["a", "a/deeper", "a/deeper/y.md", "a/z.md", "b.md"])
    XCTAssertEqual(paths(call(["op": "list", "path": "a"])), ["a/deeper", "a/z.md"])
    XCTAssertEqual(code(call(["op": "list", "path": "missing"])), "not_found")
    XCTAssertEqual(code(call(["op": "list", "path": "b.md"])), "bad_path")
  }

  func testListStopsDescendingAtTheDepthCap() throws {
    let deep = (1...40).map { "d\($0)" }.joined(separator: "/")
    _ = call(["op": "list"])
    try FileManager.default.createDirectory(atPath: "\(root)/\(deep)", withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: "\(root)/\(deep)/leaf.md", contents: Data("x".utf8))
    let listed = paths(call(["op": "list", "path": "", "recursive": true]))
    XCTAssertEqual(listed.count, PluginFileStore.maxDepth)
    XCTAssertFalse(listed.contains { $0.hasSuffix("leaf.md") })
  }

  func testListOverTheEntryCapIsTooLarge() throws {
    _ = call(["op": "list"])
    for index in 0...PluginFileStore.maxEntries { FileManager.default.createFile(atPath: "\(root)/f\(index)", contents: nil) }
    XCTAssertEqual(code(call(["op": "list"])), "too_large")
  }

  func testPlaceholdersAreListedUnderTheirRealName() throws {
    _ = call(["op": "list"])
    let plist = try PropertyListSerialization.data(fromPropertyList: ["NSURLFileSizeKey": 1234, "NSURLNameKey": "note.md"], format: .binary, options: 0)
    FileManager.default.createFile(atPath: "\(root)/.note.md.icloud", contents: plist)
    let entries = call(["op": "list"])["entries"] as? [[String: Any]] ?? []
    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(entries.first?["path"] as? String, "note.md")
    XCTAssertEqual(entries.first?["placeholder"] as? Bool, true)
    XCTAssertEqual(entries.first?["size"] as? Int64, 1234)
    XCTAssertEqual(code(call(["op": "read", "path": "note.md"])), "unavailable")
    XCTAssertEqual(code(write("note.md", "x", exclusive: true)), "exists")
    XCTAssertEqual(call(["op": "stat", "path": "note.md"])["found"] as? Bool, true)
    XCTAssertEqual(call(["op": "remove", "path": "note.md"])["removed"] as? Bool, true)
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/.note.md.icloud"))
  }

  func testRemove() throws {
    _ = write("dir/f.md", "x")
    XCTAssertEqual(code(call(["op": "remove", "path": "dir"])), "refused")
    XCTAssertEqual(call(["op": "remove", "path": "dir/f.md"])["removed"] as? Bool, true)
    XCTAssertEqual(call(["op": "remove", "path": "dir"])["removed"] as? Bool, true)
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/dir"))
    XCTAssertEqual(call(["op": "remove", "path": "dir"])["removed"] as? Bool, false)
    XCTAssertEqual(call(["op": "remove", "path": "no/such/file"])["removed"] as? Bool, false)
  }

  func testStat() {
    _ = write("a/f.md", "abc")
    let file = call(["op": "stat", "path": "a/f.md"])
    XCTAssertEqual(file["found"] as? Bool, true)
    XCTAssertEqual(file["kind"] as? String, "file")
    XCTAssertEqual(file["size"] as? Int64, 3)
    XCTAssertEqual(call(["op": "stat", "path": "a"])["kind"] as? String, "dir")
    XCTAssertEqual(call(["op": "stat", "path": ""])["kind"] as? String, "dir")
    XCTAssertEqual(call(["op": "stat", "path": "nope"])["found"] as? Bool, false)
  }

  func testDataCapPerCall() {
    let big = Data(count: PluginFileStore.maxData + 1).base64EncodedString()
    XCTAssertEqual(code(call(["op": "write", "path": "big", "data": big])), "too_large")
    XCTAssertEqual(code(call(["op": "append", "path": "big", "data": big])), "too_large")
    let exact = Data(count: PluginFileStore.maxData).base64EncodedString()
    XCTAssertEqual(call(["op": "write", "path": "big", "data": exact])["ok"] as? Bool, true)
    XCTAssertEqual(code(call(["op": "write", "path": "x", "data": "not base64!"])), "refused")
  }

  func testQuotaCountsReplacesAppendsAndRemoves() {
    let small = PluginFileQuota(cap: 100)
    let capped = PluginFileStore(root: root, isData: true, quota: small)
    XCTAssertEqual(write("a", String(repeating: "x", count: 60), on: capped)["ok"] as? Bool, true)
    XCTAssertEqual(write("a", String(repeating: "x", count: 90), on: capped)["ok"] as? Bool, true)
    XCTAssertEqual(code(write("b", String(repeating: "x", count: 20), on: capped)), "too_large")
    XCTAssertEqual(code(call(["op": "append", "path": "a", "data": b64(String(repeating: "x", count: 11))], on: capped)), "too_large")
    XCTAssertEqual(call(["op": "append", "path": "a", "data": b64(String(repeating: "x", count: 10))], on: capped)["ok"] as? Bool, true)
    XCTAssertEqual(call(["op": "remove", "path": "a"], on: capped)["removed"] as? Bool, true)
    XCTAssertEqual(write("b", String(repeating: "x", count: 100), on: capped)["ok"] as? Bool, true)
  }

  func testQuotaMeasuresWhatIsAlreadyThere() throws {
    try FileManager.default.createDirectory(atPath: "\(root)/old", withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: "\(root)/old/blob", contents: Data(count: 80))
    let capped = PluginFileStore(root: root, isData: true, quota: PluginFileQuota(cap: 100))
    XCTAssertEqual(code(write("b", String(repeating: "x", count: 21), on: capped)), "too_large")
    XCTAssertEqual(write("b", String(repeating: "x", count: 20), on: capped)["ok"] as? Bool, true)
  }

  func testReadWindowAndTooBigFile() throws {
    _ = call(["op": "list"])
    var bytes = Data(count: PluginFileStore.maxData + 10)
    bytes[PluginFileStore.maxData + 5] = 7
    FileManager.default.createFile(atPath: "\(root)/big.bin", contents: bytes)
    XCTAssertEqual(code(call(["op": "read", "path": "big.bin"])), "too_large")
    let window = call(["op": "read", "path": "big.bin", "offset": PluginFileStore.maxData + 4, "length": 3])
    XCTAssertEqual(window["size"] as? Int64, Int64(PluginFileStore.maxData + 10))
    XCTAssertEqual(Data(base64Encoded: window["data"] as! String), Data([0, 7, 0]))
    let past = call(["op": "read", "path": "big.bin", "offset": PluginFileStore.maxData + 100])
    XCTAssertEqual(past["found"] as? Bool, true)
    XCTAssertEqual(past["data"] as? String, "")
    let capped = call(["op": "read", "path": "big.bin", "offset": 0, "length": PluginFileStore.maxData * 2])
    XCTAssertEqual(Data(base64Encoded: capped["data"] as! String)?.count, PluginFileStore.maxData)
    XCTAssertEqual(code(call(["op": "read", "path": "big.bin", "offset": -1])), "bad_path")
  }

  func testICloudLocation() {
    let home = NSHomeDirectory()
    XCTAssertTrue(PluginFileStore.isInICloud("\(PluginFileStore.realPath(home) ?? home)/Library/Mobile Documents/com~apple~CloudDocs/Ardia Shared/Notes"))
    XCTAssertFalse(PluginFileStore.isInICloud("/tmp/Library/Mobile Documents/x"))
    XCTAssertFalse(PluginFileStore.isInICloud("\(home)/Library/Mobile Documentsx"))
  }

  func testGrantRootsArePlainAbsolutePaths() {
    for path in ["/private/tmp/x", "/Users/a/Library/Mobile Documents/com~apple~CloudDocs/Ardia Shared/Notes"] { XCTAssertTrue(PluginFileStore.isPlainAbsolute(path), path) }
    for path in ["", "/", "x", "/a/", "/a//b", "/a/./b", "/a/../b", "/a\u{0}b"] { XCTAssertFalse(PluginFileStore.isPlainAbsolute(path), path) }
  }

  func testProtectedRoots() throws {
    let data = "\(base)/AppData"
    let config = "\(base)/Config"
    try FileManager.default.createDirectory(atPath: "\(data)/PluginData/x", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: "\(base)/Shared/Notes", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: "\(base)/alias", withDestinationPath: data)
    let guarded = [data, config]
    let home = "\(base)/Home"
    try FileManager.default.createDirectory(atPath: "\(home)/Library/Mobile Documents/com~apple~CloudDocs/N", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: "\(home)/Library/Preferences", withIntermediateDirectories: true)
    for path in [data, "\(data)/PluginData", "\(data)/PluginData/x", "\(base)/alias", "\(base)/alias/PluginData", base, config, "/", home, "\(home)/Library", "\(home)/Library/Preferences"] {
      XCTAssertTrue(PluginFileStore.isProtected(path, guarding: guarded, home: home), path)
    }
    for path in ["\(base)/Shared", "\(base)/Shared/Notes", "\(home)/Library/Mobile Documents", "\(home)/Library/Mobile Documents/com~apple~CloudDocs/N", "\(home)/Documents"] {
      XCTAssertFalse(PluginFileStore.isProtected(path, guarding: guarded, home: home), path)
    }
  }

  func testCoordinatedWritesWorkOutsideICloud() throws {
    let grant = "\(base)/coordinated"
    try FileManager.default.createDirectory(atPath: grant, withIntermediateDirectories: true)
    let coordinated = PluginFileStore(root: grant, isData: false, coordinated: true)
    XCTAssertEqual(write("a/n.md", "x", on: coordinated)["ok"] as? Bool, true)
    XCTAssertEqual(call(["op": "append", "path": "a/n.md", "data": b64("y")], on: coordinated)["size"] as? Int64, 2)
    XCTAssertEqual(text("a/n.md", on: coordinated), "xy")
    XCTAssertEqual(call(["op": "remove", "path": "a/n.md"], on: coordinated)["removed"] as? Bool, true)
  }
}

final class PluginFileWatcherTests: XCTestCase {
  func testRelativePathsDropTemporariesAndMapPlaceholders() {
    XCTAssertEqual(PluginFileWatcher.relative("/r/a/b.md", to: "/r"), "a/b.md")
    XCTAssertEqual(PluginFileWatcher.relative("/r/a/.b.md.icloud", to: "/r"), "a/b.md")
    XCTAssertNil(PluginFileWatcher.relative("/r/.b.md.ardia-\(UUID().uuidString)", to: "/r"))
    XCTAssertNil(PluginFileWatcher.relative("/rx/a", to: "/r"))
    XCTAssertNil(PluginFileWatcher.relative("/r", to: "/r"))
  }

  func testWritesArriveCoalescedAndRelative() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-watch-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: made) }
    let root = PluginFileStore.realPath(made.path)!
    let store = PluginFileStore(root: root, isData: false)
    let seen = expectation(description: "change")
    seen.assertForOverFulfill = false
    let lock = NSLock()
    var batches: [[String]] = []
    let watcher = PluginFileWatcher(root: made.path) { paths in
      lock.withLock { batches.append(paths) }
      if paths.contains("notes/a.md") { seen.fulfill() }
    }
    XCTAssertTrue(watcher.start())
    Thread.sleep(forTimeInterval: 0.3)
    XCTAssertEqual(store.perform(["op": "write", "path": "notes/a.md", "data": Data("x".utf8).base64EncodedString()])["ok"] as? Bool, true)
    _ = store.perform(["op": "write", "path": "notes/a.md", "data": Data("y".utf8).base64EncodedString()])
    wait(for: [seen], timeout: 5)
    watcher.stop()
    let all = lock.withLock { batches.flatMap { $0 } }
    XCTAssertFalse(all.contains { $0.contains(".ardia-") })
    XCTAssertTrue(all.allSatisfy { !$0.hasPrefix("/") })
  }
}
