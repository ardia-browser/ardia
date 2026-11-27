import XCTest

@testable import ArdiaPluginCore

final class PluginFileRootBindingTests: XCTestCase {
  var base = ""

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-files-bind-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    base = PluginFileStore.realPath(made.path)!
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: base)
  }

  func identity(_ path: String) -> PluginFileIdentity { PluginFileIdentity.of(path)! }

  func testWatchOfASwappedRootStopsAndSaysGone() throws {
    let root = "\(base)/grant"
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    let lock = NSLock()
    var seen: [String] = []
    let gone = expectation(description: "gone")
    let made = PluginFileWatcher.verified(PluginFileStore(root: root, isData: false, identity: identity(root)), onGone: { gone.fulfill() }) { paths in
      lock.withLock { seen += paths }
    }
    guard case .success(let watcher) = made else { return XCTFail("the watch didn't start") }
    XCTAssertTrue(watcher.start())
    Thread.sleep(forTimeInterval: 0.3)
    FileManager.default.createFile(atPath: "\(root)/before.md", contents: Data("x".utf8))
    Thread.sleep(forTimeInterval: 0.5)
    XCTAssertTrue(lock.withLock { seen }.contains("before.md"))
    try FileManager.default.moveItem(atPath: root, toPath: "\(base)/away")
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: "\(root)/planted.md", contents: Data("x".utf8))
    wait(for: [gone], timeout: 5)
    Thread.sleep(forTimeInterval: 0.4)
    watcher.stop()
    XCTAssertFalse(lock.withLock { seen }.contains("planted.md"))
  }

  func testWatchRefusesARootThatIsNotTheBoundFolder() throws {
    let root = "\(base)/grant"
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    let wrong = PluginFileIdentity(device: identity(root).device, inode: identity(root).inode + 1)
    guard case .failure(let failure) = PluginFileWatcher.verified(PluginFileStore(root: root, isData: false, identity: wrong), onGone: {}, onChange: { _ in }) else {
      return XCTFail("a watch on the wrong folder started")
    }
    XCTAssertEqual(failure.code, .unavailable)
  }

  func testStoppingFromItsOwnCallbackDoesNotHang() throws {
    let root = "\(base)/grant"
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    let stopped = expectation(description: "stopped")
    var holder: PluginFileWatcher?
    let made = PluginFileWatcher.verified(PluginFileStore(root: root, isData: false), onGone: {}) { _ in
      holder?.stop()
      stopped.fulfill()
    }
    guard case .success(let watcher) = made else { return XCTFail("the watch didn't start") }
    holder = watcher
    XCTAssertTrue(watcher.start())
    Thread.sleep(forTimeInterval: 0.3)
    FileManager.default.createFile(atPath: "\(root)/a.md", contents: Data("x".utf8))
    wait(for: [stopped], timeout: 5)
    holder = nil
  }

  func create(_ parent: String, _ identity: PluginFileIdentity?, _ name: String, grandparent: PluginFileIdentity? = nil, guarding: [String] = []) -> [String: Any] {
    PluginFileStore.createFolder(in: parent, identity: identity, named: name, grandparentIdentity: grandparent, guarding: guarding, home: "\(base)/Home")
  }

  func testCreateLandsInTheCheckedParentAndAnswersItsIdentity() throws {
    let parent = "\(base)/Ardia Shared"
    try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
    let first = create(parent, identity(parent), "Notes")
    XCTAssertEqual(first["ok"] as? Bool, true)
    XCTAssertEqual(first["path"] as? String, "\(parent)/Notes")
    XCTAssertEqual(first["realPath"] as? String, "\(parent)/Notes")
    XCTAssertEqual(first["location"] as? String, "other")
    XCTAssertEqual(PluginFileIdentity(spec: first), identity("\(parent)/Notes"))
    XCTAssertEqual(create(parent, identity(parent), "Notes")["path"] as? String, "\(parent)/Notes 2")
  }

  func testCreateRefusesASwappedParent() throws {
    let parent = "\(base)/Ardia Shared"
    try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
    let checked = identity(parent)
    try FileManager.default.moveItem(atPath: parent, toPath: "\(base)/old")
    try FileManager.default.createDirectory(atPath: "\(base)/elsewhere", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: parent, withDestinationPath: "\(base)/elsewhere")
    XCTAssertEqual(create(parent, checked, "Notes")["code"] as? String, "refused")
    try FileManager.default.removeItem(atPath: parent)
    try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
    XCTAssertEqual(create(parent, checked, "Notes")["code"] as? String, "unavailable")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent), [])
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: "\(base)/elsewhere"), [])
  }

  func testCreateRefusesProtectedPlacesAndBadNames() throws {
    let data = "\(base)/AppData"
    try FileManager.default.createDirectory(atPath: data, withIntermediateDirectories: true)
    XCTAssertEqual(create(data, identity(data), "Notes", guarding: [data])["code"] as? String, "refused")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(data)/Notes"))
    let parent = "\(base)/Shared"
    try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
    for name in ["", ".hidden", "a/b", "a:b", "a\u{1}b", String(repeating: "x", count: 101)] {
      XCTAssertEqual(create(parent, identity(parent), name)["code"] as? String, "bad_path", name)
    }
    XCTAssertEqual(create("relative", nil, "Notes")["code"] as? String, "bad_path")
  }

  func testAnAbsentParentIsMadeUnderTheCheckedGrandparent() throws {
    let grandparent = "\(base)/Cloud"
    try FileManager.default.createDirectory(atPath: grandparent, withIntermediateDirectories: true)
    let parent = "\(grandparent)/Ardia Shared"
    let made = create(parent, nil, "Notes", grandparent: identity(grandparent))
    XCTAssertEqual(made["ok"] as? Bool, true)
    XCTAssertEqual(made["realPath"] as? String, "\(parent)/Notes")
    XCTAssertEqual(PluginFileIdentity(spec: made), identity("\(parent)/Notes"))
  }

  func testAParentThatAppearsAfterTheCheckIsNotUsed() throws {
    let grandparent = "\(base)/Cloud"
    try FileManager.default.createDirectory(atPath: grandparent, withIntermediateDirectories: true)
    let checked = identity(grandparent)
    let parent = "\(grandparent)/Ardia Shared"
    try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
    XCTAssertEqual(create(parent, nil, "Notes", grandparent: checked)["code"] as? String, "unavailable")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent), [])
    try FileManager.default.removeItem(atPath: parent)
    try FileManager.default.createDirectory(atPath: "\(base)/Other", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: parent, withDestinationPath: "\(base)/Other")
    XCTAssertEqual(create(parent, nil, "Notes", grandparent: checked)["code"] as? String, "unavailable")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: "\(base)/Other"), [])
  }

  func testAGrandparentSwappedAfterTheCheckIsNotUsed() throws {
    let grandparent = "\(base)/Cloud"
    try FileManager.default.createDirectory(atPath: grandparent, withIntermediateDirectories: true)
    let checked = identity(grandparent)
    try FileManager.default.moveItem(atPath: grandparent, toPath: "\(base)/OldCloud")
    try FileManager.default.createDirectory(atPath: grandparent, withIntermediateDirectories: true)
    XCTAssertEqual(create("\(grandparent)/Ardia Shared", nil, "Notes", grandparent: checked)["code"] as? String, "unavailable")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: grandparent), [])
    XCTAssertEqual(create("\(grandparent)/Ardia Shared", nil, "Notes", grandparent: identity(grandparent), guarding: [grandparent])["code"] as? String, "refused")
  }

  func testWithoutAParentIdentityAnExistingParentIsNeverUsed() throws {
    let parent = "\(base)/Ardia Shared"
    try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
    XCTAssertEqual(create(parent, nil, "Notes")["code"] as? String, "refused")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent), [])
  }
}
