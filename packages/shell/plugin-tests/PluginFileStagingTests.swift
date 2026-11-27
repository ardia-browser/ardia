import XCTest

@testable import ArdiaPluginCore

final class PluginFileStagingTests: XCTestCase {
  var base = ""
  var store: PluginFileStore!

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-staging-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    base = PluginFileStore.realPath(made.path)!
    store = PluginFileStore(root: "\(base)/files", isData: true, quota: PluginFileQuota())
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: base)
  }

  func b64(_ text: String) -> String { Data(text.utf8).base64EncodedString() }

  var identities: [String: [String: Any]] = [:]

  func stage(_ path: String, _ id: String, _ text: String, first: Bool) -> [String: Any] {
    var spec: [String: Any] = ["op": "stage", "path": path, "stage": id, "data": b64(text), "first": first]
    if let known = identities[id] { spec["stageIdentity"] = known }
    let reply = store.perform(spec)
    if first, reply["ok"] as? Bool == true { identities[id] = ["device": reply["device"] as Any, "inode": reply["inode"] as Any] }
    return reply
  }

  func finish(_ op: String, _ path: String, _ id: String) -> [String: Any] {
    store.perform(["op": op, "path": path, "stage": id, "stageIdentity": identities[id] as Any])
  }

  func text(_ path: String) -> String? {
    let reply = store.perform(["op": "read", "path": path])
    guard reply["found"] as? Bool == true, let data = (reply["data"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return nil }
    return String(decoding: data, as: UTF8.self)
  }

  func testStagedPartsAreHiddenUntilPublishedThenAppearAtOnce() {
    let id = UUID().uuidString
    XCTAssertEqual(stage("dl/x.zip", id, "ab", first: true)["ok"] as? Bool, true)
    XCTAssertEqual(stage("dl/x.zip", id, "cd", first: false)["ok"] as? Bool, true)
    XCTAssertNil(text("dl/x.zip"), "nothing at the path while staging")
    let listed = store.perform(["op": "list", "path": "dl"])
    XCTAssertEqual((listed["entries"] as? [[String: Any]] ?? []).count, 0, "the staging file is hidden from the plugin")
    XCTAssertEqual(finish("publish", "dl/x.zip", id)["ok"] as? Bool, true)
    XCTAssertEqual(text("dl/x.zip"), "abcd")
  }

  func testPublishNeverReplacesAFileAndDiscardLeavesIt() {
    _ = store.perform(["op": "write", "path": "keep.zip", "data": b64("mine")])
    let id = UUID().uuidString
    _ = stage("keep.zip", id, "theirs", first: true)
    XCTAssertEqual(finish("publish", "keep.zip", id)["code"] as? String, "exists")
    XCTAssertEqual(finish("discard", "keep.zip", id)["removed"] as? Bool, true)
    XCTAssertEqual(text("keep.zip"), "mine")
  }

  func testAFirstPartNeverOpensAnExistingStageAndOnlyArdiaIdsWork() {
    let id = UUID().uuidString
    _ = stage("x", id, "a", first: true)
    XCTAssertEqual(stage("x", id, "b", first: true)["ok"] as? Bool, false, "a second first part can't reuse the file")
    XCTAssertEqual(stage("x", "not-a-uuid", "b", first: true)["code"] as? String, "bad_path")
    XCTAssertEqual(store.perform(["op": "write", "path": PluginFileStore.stagingName(for: "x", stage: id)!, "data": b64("z")])["code"] as? String, "bad_path", "a plugin can't name a staging file")
  }

  func testQuotaIsItsOwnError() {
    let small = PluginFileStore(root: "\(base)/files", isData: true, quota: PluginFileQuota(cap: 4))
    let reply = small.perform(["op": "stage", "path": "q", "stage": UUID().uuidString, "data": b64("too big"), "first": true])
    XCTAssertEqual(reply["code"] as? String, "quota")
  }

  func testCleanupRemovesOnlyTheStageThisOperationMade() {
    let id = UUID().uuidString
    XCTAssertEqual(stage("own.zip", id, "a", first: true)["ok"] as? Bool, true)
    let staging = "\(base)/files/\(PluginFileStore.stagingName(for: "own.zip", stage: id)!)"
    try? FileManager.default.removeItem(atPath: staging)
    try? "someone else's".write(toFile: staging, atomically: false, encoding: .utf8)
    XCTAssertEqual(finish("discard", "own.zip", id)["removed"] as? Bool, false, "an entry Ardia didn't make is left")
    XCTAssertEqual(try? String(contentsOfFile: staging, encoding: .utf8), "someone else's")
    XCTAssertEqual(stage("own.zip", id, "b", first: false)["ok"] as? Bool, false, "a later part refuses a stage that isn't its own")
    XCTAssertEqual(finish("publish", "own.zip", id)["ok"] as? Bool, false, "and so does publish")
    XCTAssertEqual(store.perform(["op": "discard", "path": "own.zip", "stage": id])["removed"] as? Bool, false, "without the identity nothing is removed")
  }
}
