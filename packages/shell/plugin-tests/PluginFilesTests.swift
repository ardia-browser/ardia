import XCTest

@testable import ArdiaPluginCore

final class PluginFilesTests: XCTestCase {
  var root = ""

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-files-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = PluginSandbox.resolved(made.path)!
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  func testALogThatIsntARegularFileIsRefusedWithoutBlocking() throws {
    let folder = try XCTUnwrap(PluginFiles.openDataFolder(root))
    defer { folder.close() }
    XCTAssertEqual(mkfifo("\(root)/plugin.log", 0o600), 0)
    let opened = expectation(description: "openLog returns")
    var fd: Int32 = 0
    Thread.detachNewThread {
      fd = PluginFiles.openLog(in: folder)
      opened.fulfill()
    }
    wait(for: [opened], timeout: 2)
    XCTAssertLessThan(fd, 0, "a FIFO is never the log")
  }

  func testTheLogIsARegularFileOpenedForAppending() throws {
    let folder = try XCTUnwrap(PluginFiles.openDataFolder(root))
    defer { folder.close() }
    let fd = PluginFiles.openLog(in: folder)
    XCTAssertGreaterThanOrEqual(fd, 0)
    var info = stat()
    XCTAssertEqual(fstat(fd, &info), 0)
    XCTAssertEqual(info.st_mode & S_IFMT, S_IFREG)
    close(fd)
  }
}

final class PluginFolderBindingTests: XCTestCase {
  var root = ""

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-folder-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = PluginSandbox.resolved(made.path)!
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  func makePlugin(_ path: String, manifest: String) throws {
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    try manifest.write(toFile: "\(path)/plugin.json", atomically: false, encoding: .utf8)
  }

  func testTheManifestAndTheIdentityComeFromTheSameFolderEvenIfItIsSwappedMidScan() throws {
    let path = "\(root)/example"
    try makePlugin(path, manifest: "{\"name\":\"approved\"}")
    let folder = try XCTUnwrap(PluginFiles.openFolder(path))
    defer { folder.close() }
    try FileManager.default.moveItem(atPath: path, toPath: "\(root)/old")
    try makePlugin(path, manifest: "{\"name\":\"swapped\"}")
    XCTAssertEqual(PluginFiles.readManifest(in: folder), .text("{\"name\":\"approved\"}"))
    var info = stat()
    XCTAssertEqual(stat("\(root)/old", &info), 0)
    XCTAssertEqual(folder.id, "\(info.st_dev):\(info.st_ino)")
  }

  func testLaunchingIsBoundToTheApprovedFolderAndManifest() throws {
    let path = "\(root)/example"
    let manifest = "{\"name\":\"example\"}"
    try makePlugin(path, manifest: manifest)
    let scanned = try XCTUnwrap(PluginFiles.openFolder(path))
    let id = scanned.id
    scanned.close()
    let approved = PluginFiles.approvalHash(text: manifest, folderId: id)
    guard case .success(let bound) = PluginFiles.approvedFolder(path, folderId: id, approved: approved) else { return XCTFail("the approved folder launches") }
    bound.close()
    try FileManager.default.moveItem(atPath: path, toPath: "\(root)/old")
    try makePlugin(path, manifest: manifest)
    guard case .failure(let why) = PluginFiles.approvedFolder(path, folderId: id, approved: approved) else { return XCTFail("a swapped folder with the same manifest is refused") }
    XCTAssertTrue(why.reason.contains("replaced"))
    try FileManager.default.removeItem(atPath: path)
    try FileManager.default.moveItem(atPath: "\(root)/old", toPath: path)
    try "{\"name\":\"example\",\"permissions\":[\"network\"]}".write(toFile: "\(path)/plugin.json", atomically: false, encoding: .utf8)
    guard case .failure(let changed) = PluginFiles.approvedFolder(path, folderId: id, approved: approved) else { return XCTFail("a changed manifest is refused") }
    XCTAssertTrue(changed.reason.contains("changed"))
  }

  func testASymlinkedManifestIsRefused() throws {
    let path = "\(root)/example"
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    try "{\"name\":\"example\"}".write(toFile: "\(root)/outside.json", atomically: false, encoding: .utf8)
    try FileManager.default.createSymbolicLink(atPath: "\(path)/plugin.json", withDestinationPath: "\(root)/outside.json")
    let folder = try XCTUnwrap(PluginFiles.openFolder(path))
    defer { folder.close() }
    XCTAssertEqual(PluginFiles.readManifest(in: folder).status, "link", "a plugin.json that is a link is never read")
  }
}

final class PluginBeneathTests: XCTestCase {
  var root = ""

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-beneath-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = PluginSandbox.resolved(made.path)!
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  func write(_ text: String, _ path: String) throws {
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try text.write(toFile: path, atomically: false, encoding: .utf8)
  }

  func read(_ fd: Int32) -> String? {
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    return String(data: FileHandle(fileDescriptor: fd, closeOnDealloc: false).readDataToEndOfFile(), encoding: .utf8)
  }

  func testPageFilesAndTheProgramComeFromTheVerifiedFolderEvenAfterASwap() throws {
    let path = "\(root)/example"
    try write("approved page", "\(path)/page/index.html")
    try write("#!/bin/sh\n", "\(path)/bin/helper")
    chmod("\(path)/bin/helper", 0o755)
    let folder = try XCTUnwrap(PluginFiles.openFolder(path))
    defer { folder.close() }
    try FileManager.default.moveItem(atPath: path, toPath: "\(root)/moved")
    try write("swapped page", "\(path)/page/index.html")
    XCTAssertEqual(read(PluginFiles.openBeneath(folder.fd, "page/index.html", flags: O_RDONLY)), "approved page")
    XCTAssertEqual(PluginFiles.localProgram("bin/helper", in: folder), "./bin/helper", "run relative to the verified folder it starts in")
  }

  func testLinksAndParentStepsInsideThePluginAreRefused() throws {
    let path = "\(root)/example"
    try write("secret", "\(root)/outside/secret.txt")
    try write("#!/bin/sh\n", "\(root)/outside/tool")
    chmod("\(root)/outside/tool", 0o755)
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: "\(path)/page", withDestinationPath: "\(root)/outside")
    let folder = try XCTUnwrap(PluginFiles.openFolder(path))
    defer { folder.close() }
    XCTAssertLessThan(PluginFiles.openBeneath(folder.fd, "page/secret.txt", flags: O_RDONLY), 0)
    XCTAssertLessThan(PluginFiles.openBeneath(folder.fd, "../outside/secret.txt", flags: O_RDONLY), 0)
    XCTAssertNil(PluginFiles.localProgram("page/tool", in: folder))
  }

  func testASlashJoinedToACombiningMarkIsStillAPathSeparator() throws {
    let path = "\(root)/marked"
    try write("secret", "\(root)/outside2/\u{301}secret.txt")
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: "\(path)/link", withDestinationPath: "\(root)/outside2")
    let folder = try XCTUnwrap(PluginFiles.openFolder(path))
    defer { folder.close() }
    XCTAssertLessThan(PluginFiles.openBeneath(folder.fd, "link/\u{301}secret.txt", flags: O_RDONLY), 0)
    XCTAssertEqual(PluginFiles.pathParts("a/\u{301}b"), ["a", "\u{301}b"])
    XCTAssertNil(PluginFiles.pathParts("a//b"))
    XCTAssertNil(PluginFiles.pathParts("a/../b"))
    XCTAssertNil(PluginFiles.pathParts(""))
  }

  func testTheLogOpensOnlyInsideARealDataFolder() throws {
    let data = "\(root)/PluginData/example"
    try FileManager.default.createDirectory(atPath: "\(root)/elsewhere", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: "\(root)/PluginData", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: data, withDestinationPath: "\(root)/elsewhere")
    XCTAssertNil(PluginFiles.openDataFolder(data), "a linked data folder is refused")
    try FileManager.default.removeItem(atPath: data)
    try FileManager.default.createDirectory(atPath: data, withIntermediateDirectories: false)
    let folder = try XCTUnwrap(PluginFiles.openDataFolder(data))
    defer { folder.close() }
    try FileManager.default.createSymbolicLink(atPath: "\(data)/plugin.log", withDestinationPath: "\(root)/elsewhere/log")
    XCTAssertLessThan(PluginFiles.openLog(in: folder), 0)
    try FileManager.default.removeItem(atPath: "\(data)/plugin.log")
    let log = PluginFiles.openLog(in: folder)
    XCTAssertGreaterThanOrEqual(log, 0)
    close(log)
    var info = stat()
    XCTAssertEqual(lstat("\(data)/home", &info), 0)
    XCTAssertEqual(info.st_mode & S_IFMT, S_IFDIR)
  }
}

final class PluginPageFileTests: XCTestCase {
  func testAPageFileIsServedOnlyWhileTheApprovedManifestIsInPlace() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-page-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made.appendingPathComponent("page"), withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: made) }
    let path = PluginSandbox.resolved(made.path)!
    let manifest = "{\"name\":\"example\"}"
    try manifest.write(toFile: "\(path)/plugin.json", atomically: false, encoding: .utf8)
    try "page".write(toFile: "\(path)/page/index.html", atomically: false, encoding: .utf8)
    let folder = try XCTUnwrap(PluginFiles.openFolder(path))
    let id = folder.id
    folder.close()
    let approved = PluginFiles.approvalHash(text: manifest, folderId: id)
    XCTAssertEqual(PluginFiles.readPageFile(path, folderId: id, approved: approved, relative: "page/index.html"), Data("page".utf8))
    try "{\"name\":\"example\",\"permissions\":[\"network\"]}".write(toFile: "\(path)/plugin.json", atomically: false, encoding: .utf8)
    XCTAssertNil(PluginFiles.readPageFile(path, folderId: id, approved: approved, relative: "page/index.html"), "an edited manifest stops the page at once")
  }
}

final class PluginReadAllTests: XCTestCase {
  func testAReadErrorIsAFailedReadNotACrash() throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("read-\(UUID().uuidString)").path
    try "page".write(toFile: path, atomically: false, encoding: .utf8)
    defer { try? FileManager.default.removeItem(atPath: path) }
    let fd = open(path, O_WRONLY)
    XCTAssertGreaterThanOrEqual(fd, 0)
    defer { close(fd) }
    XCTAssertNil(PluginFiles.readAll(fd, limit: 1 << 20), "read fails with EBADF, and the request fails with it")
  }

  func testAReadStopsPastTheLimitAndReadsToTheEndOtherwise() throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("read-\(UUID().uuidString)").path
    try Data(repeating: 7, count: 200_000).write(to: URL(fileURLWithPath: path))
    defer { try? FileManager.default.removeItem(atPath: path) }
    for (limit, expected) in [(200_000, 200_000), (199_999, nil)] as [(Int, Int?)] {
      let fd = open(path, O_RDONLY)
      defer { close(fd) }
      XCTAssertEqual(PluginFiles.readAll(fd, limit: limit)?.count, expected)
    }
  }
}
