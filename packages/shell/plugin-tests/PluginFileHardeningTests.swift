import XCTest

@testable import ArdiaPluginCore

final class PluginFileHardeningTests: XCTestCase {
  var base = ""
  var root: String { "\(base)/files" }
  var store: PluginFileStore!

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-files-hard-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    base = PluginFileStore.realPath(made.path)!
    store = PluginFileStore(root: root, isData: true, quota: PluginFileQuota())
    _ = store.perform(["op": "list"])
  }

  override func tearDownWithError() throws {
    PluginFileStore.commitPoint = nil
    PluginFileStore.mutationPoint = nil
    try? FileManager.default.removeItem(atPath: base)
  }

  func b64(_ text: String) -> String { Data(text.utf8).base64EncodedString() }

  func code(_ reply: [String: Any]) -> String? { reply["ok"] as? Bool == false ? reply["code"] as? String : nil }

  func write(_ path: String, _ text: String, on given: PluginFileStore? = nil) -> [String: Any] {
    (given ?? store).perform(["op": "write", "path": path, "data": b64(text)])
  }

  func identity(_ path: String) throws -> PluginFileIdentity {
    var info = stat()
    XCTAssertEqual(stat(path, &info), 0)
    return PluginFileIdentity(device: Int64(info.st_dev), inode: Int64(info.st_ino))
  }

  func testFirmlinkAliasOfAProtectedFolderIsProtected() throws {
    let data = "\(base)/AppData"
    try FileManager.default.createDirectory(atPath: "\(data)/PluginData", withIntermediateDirectories: true)
    let alias = "/System/Volumes/Data\(data)"
    try XCTSkipUnless(FileManager.default.fileExists(atPath: alias), "no firmlinked data volume here")
    let home = "\(base)/Home"
    XCTAssertTrue(PluginFileStore.isProtected(alias, guarding: [data], home: home))
    XCTAssertTrue(PluginFileStore.isProtected("\(alias)/PluginData", guarding: [data], home: home))
    XCTAssertTrue(PluginFileStore.isProtected("/System/Volumes/Data\(base)", guarding: [data], home: home))
    XCTAssertTrue(PluginFileStore.isProtected("/System/Volumes/Data", guarding: [], home: home))
    XCTAssertTrue(PluginFileStore.isProtected("/System/Volumes/Data/Users", guarding: [], home: home))
    try FileManager.default.createDirectory(atPath: "\(base)/Shared", withIntermediateDirectories: true)
    XCTAssertFalse(PluginFileStore.isProtected("/System/Volumes/Data\(base)/Shared", guarding: [data], home: home))
  }

  func testGrantBoundToItsFolderIdentity() throws {
    let grant = "\(base)/grant"
    try FileManager.default.createDirectory(atPath: grant, withIntermediateDirectories: true)
    let bound = PluginFileStore(root: grant, isData: false, identity: try identity(grant))
    XCTAssertEqual(write("n.md", "x", on: bound)["ok"] as? Bool, true)
    try FileManager.default.moveItem(atPath: grant, toPath: "\(base)/moved")
    try FileManager.default.createDirectory(atPath: grant, withIntermediateDirectories: true)
    XCTAssertEqual(code(write("n.md", "x", on: bound)), "unavailable")
    XCTAssertEqual(code(bound.perform(["op": "list"])), "unavailable")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(grant)/n.md"))
  }

  func testIdentityFromSpecIsHonoured() throws {
    let grant = "\(base)/grant"
    try FileManager.default.createDirectory(atPath: grant, withIntermediateDirectories: true)
    let found = try identity(grant)
    XCTAssertEqual(PluginFileIdentity(spec: ["device": found.device, "inode": found.inode]), found)
    XCTAssertNil(PluginFileIdentity(spec: ["device": "1", "inode": 2]))
    XCTAssertNil(PluginFileIdentity(spec: nil))
  }

  func moveOut(_ name: String) -> (String) -> Void {
    let from = "\(root)/\(name)"
    let to = "\(base)/outside-\(name)"
    return { _ in try? FileManager.default.moveItem(atPath: from, toPath: to) }
  }

  func testWriteIntoAFolderMovedOutBeforeTheRenameIsRefused() throws {
    XCTAssertEqual(write("a/keep.md", "k")["ok"] as? Bool, true)
    PluginFileStore.commitPoint = moveOut("a")
    XCTAssertEqual(code(write("a/n.md", "x")), "refused")
    PluginFileStore.commitPoint = nil
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: "\(base)/outside-a"), ["keep.md"])
  }

  func testAppendIntoAFolderMovedOutIsRefused() throws {
    XCTAssertEqual(write("a/keep.md", "k")["ok"] as? Bool, true)
    PluginFileStore.commitPoint = moveOut("a")
    XCTAssertEqual(code(store.perform(["op": "append", "path": "a/log", "data": b64("x")])), "refused")
    PluginFileStore.commitPoint = nil
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: "\(base)/outside-a"), ["keep.md"])
  }

  func testRemoveAndReadInAFolderMovedOutAreRefused() throws {
    XCTAssertEqual(write("a/keep.md", "k")["ok"] as? Bool, true)
    PluginFileStore.commitPoint = moveOut("a")
    XCTAssertEqual(code(store.perform(["op": "remove", "path": "a/keep.md"])), "refused")
    PluginFileStore.commitPoint = nil
    XCTAssertTrue(FileManager.default.fileExists(atPath: "\(base)/outside-a/keep.md"))
    XCTAssertEqual(write("b/keep.md", "k")["ok"] as? Bool, true)
    PluginFileStore.commitPoint = moveOut("b")
    XCTAssertEqual(code(store.perform(["op": "read", "path": "b/keep.md"])), "refused")
  }

  func moveOutAt(_ label: String, _ name: String) -> (String) -> Void {
    let move = moveOut(name)
    return { at in if at == label { move(at) } }
  }

  func outside(_ name: String) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: "\(base)/outside-\(name)").sorted()
  }

  func testAFolderMadeAfterItsParentMovedOutIsTakenBack() throws {
    XCTAssertEqual(write("a/keep.md", "k")["ok"] as? Bool, true)
    PluginFileStore.mutationPoint = moveOutAt("mkdir:new", "a")
    XCTAssertEqual(code(write("a/new/n.md", "x")), "refused")
    PluginFileStore.mutationPoint = nil
    XCTAssertEqual(try outside("a"), ["keep.md"])
  }

  func testANewFileRenamedInAfterTheFolderMovedOutIsTakenBack() throws {
    XCTAssertEqual(write("a/keep.md", "k")["ok"] as? Bool, true)
    PluginFileStore.mutationPoint = moveOutAt("write", "a")
    XCTAssertEqual(code(write("a/n.md", "x")), "refused")
    PluginFileStore.mutationPoint = nil
    XCTAssertEqual(try outside("a"), ["keep.md"])
  }

  func testAnOverwriteAfterTheFolderMovedOutPutsTheOldFileBack() throws {
    XCTAssertEqual(write("a/keep.md", "k")["ok"] as? Bool, true)
    PluginFileStore.mutationPoint = moveOutAt("write", "a")
    XCTAssertEqual(code(write("a/keep.md", "changed")), "refused")
    PluginFileStore.mutationPoint = nil
    XCTAssertEqual(try outside("a"), ["keep.md"])
    XCTAssertEqual(try String(contentsOfFile: "\(base)/outside-a/keep.md", encoding: .utf8), "k")
  }

  func testAnAppendAfterTheFolderMovedOutIsUndone() throws {
    XCTAssertEqual(write("a/keep.md", "k")["ok"] as? Bool, true)
    PluginFileStore.mutationPoint = moveOutAt("append", "a")
    XCTAssertEqual(code(store.perform(["op": "append", "path": "a/keep.md", "data": b64("more")])), "refused")
    XCTAssertEqual(try String(contentsOfFile: "\(base)/outside-a/keep.md", encoding: .utf8), "k")
    try FileManager.default.moveItem(atPath: "\(base)/outside-a", toPath: "\(root)/a")
    PluginFileStore.mutationPoint = moveOutAt("append", "a")
    XCTAssertEqual(code(store.perform(["op": "append", "path": "a/log", "data": b64("x")])), "refused")
    PluginFileStore.mutationPoint = nil
    XCTAssertEqual(try outside("a"), ["keep.md"])
  }

  func testARemoveAfterTheFolderMovedOutPutsTheFileBack() throws {
    XCTAssertEqual(write("a/keep.md", "k")["ok"] as? Bool, true)
    PluginFileStore.mutationPoint = moveOutAt("remove", "a")
    XCTAssertEqual(code(store.perform(["op": "remove", "path": "a/keep.md"])), "refused")
    PluginFileStore.mutationPoint = nil
    XCTAssertEqual(try outside("a"), ["keep.md"])
    XCTAssertEqual(store.perform(["op": "remove", "path": "keep-missing.md"])["removed"] as? Bool, false)
    XCTAssertEqual(write("b/gone.md", "g")["ok"] as? Bool, true)
    XCTAssertEqual(store.perform(["op": "remove", "path": "b/gone.md"])["removed"] as? Bool, true, "positive control")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: "\(root)/b"), [])
  }

  func testStagingAndPublishingAfterTheFolderMovedOutAreUndone() throws {
    XCTAssertEqual(write("a/keep.md", "k")["ok"] as? Bool, true)
    let stage = UUID().uuidString
    PluginFileStore.mutationPoint = moveOutAt("stage", "a")
    XCTAssertEqual(code(store.perform(["op": "stage", "path": "a/x.zip", "stage": stage, "data": b64("part"), "first": true])), "refused")
    PluginFileStore.mutationPoint = nil
    XCTAssertEqual(try outside("a"), ["keep.md"])
    try FileManager.default.moveItem(atPath: "\(base)/outside-a", toPath: "\(root)/a")
    XCTAssertEqual(store.perform(["op": "stage", "path": "a/x.zip", "stage": stage, "data": b64("part"), "first": true])["ok"] as? Bool, true)
    PluginFileStore.mutationPoint = moveOutAt("publish", "a")
    XCTAssertEqual(code(store.perform(["op": "publish", "path": "a/x.zip", "stage": stage])), "refused")
    PluginFileStore.mutationPoint = nil
    XCTAssertFalse(try outside("a").contains("x.zip"))
  }

  func gatedStore(_ access: PluginFileAccess, operation: String? = nil) -> PluginFileStore {
    var gated = PluginFileStore(root: root, isData: true, quota: PluginFileQuota())
    gated.gate = access.gate(ticket: access.ticket(), plugin: "p", root: nil, operation: operation)
    return gated
  }

  func testARevokeAfterTheTicketCheckStopsTheWriteAtItsCommit() throws {
    let access = PluginFileAccess()
    let gated = gatedStore(access)
    PluginFileStore.commitPoint = { label in if label == "write" { access.revoke(plugin: "p", root: nil) } }
    XCTAssertEqual(code(write("late.md", "x", on: gated)), "refused")
    PluginFileStore.commitPoint = nil
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root).filter { !$0.hasPrefix(".") || $0.contains(".ardia-") }, [])
    XCTAssertEqual(write("fresh.md", "x", on: gatedStore(access))["ok"] as? Bool, true, "positive control: a ticket taken after the revoke works")
  }

  func testARevokeWaitsForACommitAlreadyUnderWay() throws {
    let access = PluginFileAccess()
    let gated = gatedStore(access)
    let order = NSLock()
    var events: [String] = []
    let revoked = expectation(description: "revoked")
    PluginFileStore.mutationPoint = { label in
      guard label == "write" else { return }
      DispatchQueue.global().async {
        access.revoke(plugin: "p", root: nil)
        let landed = FileManager.default.fileExists(atPath: "\(self.root)/racing.md")
        order.withLock { events.append(landed ? "revoked after the commit" : "revoked mid-commit") }
        revoked.fulfill()
      }
      Thread.sleep(forTimeInterval: 0.2)
      order.withLock { events.append("committing") }
    }
    XCTAssertEqual(write("racing.md", "x", on: gated)["ok"] as? Bool, true)
    PluginFileStore.mutationPoint = nil
    wait(for: [revoked], timeout: 5)
    XCTAssertEqual(order.withLock { events }, ["committing", "revoked after the commit"])
    XCTAssertEqual(code(write("after.md", "x", on: gated)), "refused")
  }

  func testAnOperationRevokedEndsOnlyThatOperationsCommits() throws {
    let access = PluginFileAccess()
    let stage = UUID().uuidString
    let gated = gatedStore(access, operation: stage)
    XCTAssertEqual(gated.perform(["op": "stage", "path": "x.zip", "stage": stage, "data": b64("part"), "first": true])["ok"] as? Bool, true)
    access.revoke(plugin: "p", root: PluginFileAccess.operationPrefix + stage)
    XCTAssertEqual(code(gated.perform(["op": "publish", "path": "x.zip", "stage": stage])), "refused")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/x.zip"))
    XCTAssertEqual(write("other.md", "x", on: gated)["ok"] as? Bool, false, "the same gate carries the operation")
    XCTAssertEqual(write("other.md", "x", on: gatedStore(access))["ok"] as? Bool, true, "other calls of the plugin go on")
  }

  func testAReadBoundToAFileRefusesAnotherFilePutAtItsName() throws {
    XCTAssertEqual(write("picked.zip", "one")["ok"] as? Bool, true)
    let first = store.perform(["op": "read", "path": "picked.zip", "offset": 0, "length": 0])
    let bound: [String: Any] = ["device": first["device"] as Any, "inode": first["inode"] as Any]
    XCTAssertEqual(store.perform(["op": "read", "path": "picked.zip", "fileIdentity": bound])["found"] as? Bool, true, "positive control")
    XCTAssertEqual(write("picked.zip", "two")["ok"] as? Bool, true)
    XCTAssertEqual(code(store.perform(["op": "read", "path": "picked.zip", "fileIdentity": bound])), "refused")
  }

  func testRecursiveListSkipsAFolderMovedOutMidway() throws {
    XCTAssertEqual(write("a/b/secret.md", "k")["ok"] as? Bool, true)
    PluginFileStore.commitPoint = { label in if label == "list:a" { try? FileManager.default.moveItem(atPath: "\(self.root)/a", toPath: "\(self.base)/outside-a") } }
    let listed = (store.perform(["op": "list", "recursive": true])["entries"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String }
    XCTAssertFalse(listed.contains("a/b/secret.md"))
  }

  func testHardLinkedFilesAreRefused() throws {
    let outside = "\(base)/outside.txt"
    try "secret".write(toFile: outside, atomically: true, encoding: .utf8)
    XCTAssertEqual(link(outside, "\(root)/linked.txt"), 0)
    XCTAssertEqual(code(store.perform(["op": "read", "path": "linked.txt"])), "refused")
    XCTAssertEqual(code(store.perform(["op": "append", "path": "linked.txt", "data": b64("x")])), "refused")
    XCTAssertEqual(code(write("linked.txt", "x")), "refused")
    XCTAssertEqual(try String(contentsOfFile: outside, encoding: .utf8), "secret")
    XCTAssertEqual(store.perform(["op": "remove", "path": "linked.txt"])["removed"] as? Bool, true)
  }

  func testPathsDeeperThanTheListCapAreRefused() {
    let deepest = (1...PluginFileStore.maxDepth).map { "d\($0)" }.joined(separator: "/")
    XCTAssertEqual(write(deepest, "x")["ok"] as? Bool, true)
    XCTAssertEqual(code(write("\(deepest)/one-more", "x")), "bad_path")
    XCTAssertEqual(code(store.perform(["op": "read", "path": "\(deepest)/one-more"])), "bad_path")
  }

  func testRawPlaceholderNamesAreRefused() throws {
    let plist = try PropertyListSerialization.data(fromPropertyList: ["NSURLFileSizeKey": 3], format: .binary, options: 0)
    FileManager.default.createFile(atPath: "\(root)/.note.md.icloud", contents: plist)
    for op in ["read", "stat", "remove", "list"] {
      XCTAssertEqual(code(store.perform(["op": op, "path": ".note.md.icloud"])), "bad_path", op)
    }
    XCTAssertEqual(code(write("a/.x.icloud", "x")), "bad_path")
    XCTAssertEqual(code(write(".icloud", "x")), nil)
    XCTAssertTrue(FileManager.default.fileExists(atPath: "\(root)/.note.md.icloud"))
  }

  func testTicketsTakenBeforeARevokeGoStale() {
    let access = PluginFileAccess()
    let before = access.ticket()
    access.revoke(plugin: "notes", root: "/g")
    XCTAssertTrue(access.allows(before, plugin: "notes", root: nil))
    XCTAssertFalse(access.allows(before, plugin: "notes", root: "/g"))
    XCTAssertTrue(access.allows(before, plugin: "notes", root: "/h"))
    XCTAssertTrue(access.allows(access.ticket(), plugin: "notes", root: "/g"))
    let second = access.ticket()
    access.revoke(plugin: "notes", root: nil)
    XCTAssertFalse(access.allows(second, plugin: "notes", root: nil))
    XCTAssertFalse(access.allows(second, plugin: "notes", root: "/h"))
    XCTAssertTrue(access.allows(second, plugin: "other", root: nil))
    XCTAssertTrue(access.allows(access.ticket(), plugin: "notes", root: nil))
    XCTAssertFalse(access.allows(nil, plugin: "other", root: nil))
    XCTAssertFalse(access.allows(-1, plugin: "other", root: nil))
  }

}
