import XCTest

@testable import ArdiaPluginCore

final class PluginProgramsTests: XCTestCase {
  var root = ""
  var places: ProgramPlaces!
  let tool = PluginProgram(name: "hello-tool", path: "bin/hello")

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-programs-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = PluginSandbox.resolved(made.path)!
    places = ProgramPlaces(store: "\(root)/Programs", binDir: "\(root)/bin")
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  func makePlugin(_ name: String, version: String, say: String) throws -> String {
    let folder = "\(root)/plugins/\(name)"
    try FileManager.default.createDirectory(atPath: "\(folder)/bin", withIntermediateDirectories: true)
    try #"{"name": "\#(name)", "version": "\#(version)", "programs": [{"name": "hello-tool", "path": "bin/hello"}]}"#.write(toFile: "\(folder)/plugin.json", atomically: true, encoding: .utf8)
    try "#!/bin/sh\necho \(say)\n".write(toFile: "\(folder)/bin/hello", atomically: true, encoding: .utf8)
    XCTAssertEqual(chmod("\(folder)/bin/hello", 0o755), 0)
    return folder
  }

  var oldHome: LegacyInstall { LegacyInstall(owner: "greeter", program: "hello-tool", base: root, relative: "OldCLI", current: "current") }

  func install(_ folder: String, plugin: String = "greeter", version: String, adopt: Bool = false) throws -> ProgramsLinked {
    let opened = try XCTUnwrap(PluginFiles.openFolder(folder))
    defer { opened.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: opened) else { throw XCTSkip("no manifest") }
    let approved = PluginFiles.approvalHash(text: text, folderId: opened.id)
    return try PluginPrograms.install(plugin: plugin, from: opened, approved: approved, version: version, programs: [tool], places: places, adoption: adopt ? oldHome : nil).get()
  }

  func run(_ path: String) -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    let pipe = Pipe()
    process.standardOutput = pipe
    try? process.run()
    process.waitUntilExit()
    return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var binPath: String { "\(places.binDir)/hello-tool" }
  var pluginStore: String { "\(places.store)/greeter" }

  func versions() -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: pluginStore)) ?? []).filter { !$0.hasPrefix(".") && $0 != "current" && $0 != "previous" }.sorted()
  }

  func testTurningOnCopiesTheFolderAndLinksTheProgramThroughCurrent() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let linked = try install(folder, version: "1.0.0")
    XCTAssertTrue(linked.fresh)
    XCTAssertEqual(linked.linked, ["hello-tool"])
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "\(pluginStore)/current/bin/hello")
    XCTAssertEqual(PluginPrograms.linkTarget("\(pluginStore)/current"), linked.version)
    XCTAssertTrue(linked.version.hasPrefix("1.0.0-"))
    XCTAssertTrue(PluginPrograms.isRealFolder("\(pluginStore)/\(linked.version)/.leases"))
    XCTAssertEqual(run(binPath), "one")
    try "#!/bin/sh\necho changed\n".write(toFile: "\(folder)/bin/hello", atomically: true, encoding: .utf8)
    XCTAssertEqual(run(binPath), "one", "the program runs from Ardia's copy, not the plugin's folder")
  }

  func testOneOpenedFolderCanBeCopiedTwice() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let opened = try XCTUnwrap(PluginFiles.openFolder(folder))
    defer { opened.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: opened) else { return XCTFail("no manifest") }
    let approved = PluginFiles.approvalHash(text: text, folderId: opened.id)
    for store in ["a", "b"] {
      let elsewhere = ProgramPlaces(store: "\(root)/\(store)", binDir: "\(root)/bin-\(store)")
      XCTAssertEqual(try PluginPrograms.install(plugin: "greeter", from: opened, approved: approved, version: "1.0.0", programs: [tool], places: elsewhere).get().linked, ["hello-tool"], store)
    }
  }

  func testTheSameApprovalReusesItsCopy() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let first = try install(folder, version: "1.0.0")
    let again = try install(folder, version: "1.0.0")
    XCTAssertEqual(first.version, again.version)
    XCTAssertFalse(again.fresh)
  }

  func testAnUpgradeKeepsThePreviousVersionAndSweepsOlderOnes() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let v1 = try install(folder, version: "1.0.0")
    try #"{"name": "greeter", "version": "2.0.0", "programs": [{"name": "hello-tool", "path": "bin/hello"}]}"#.write(toFile: "\(folder)/plugin.json", atomically: true, encoding: .utf8)
    try "#!/bin/sh\necho two\n".write(toFile: "\(folder)/bin/hello", atomically: true, encoding: .utf8)
    let v2 = try install(folder, version: "2.0.0")
    XCTAssertEqual(run(binPath), "two")
    XCTAssertEqual(PluginPrograms.linkTarget("\(pluginStore)/previous"), v1.version)
    XCTAssertEqual(versions(), [v1.version, v2.version].sorted())
    try #"{"name": "greeter", "version": "3.0.0", "programs": [{"name": "hello-tool", "path": "bin/hello"}]}"#.write(toFile: "\(folder)/plugin.json", atomically: true, encoding: .utf8)
    let v3 = try install(folder, version: "3.0.0")
    XCTAssertEqual(versions(), [v2.version, v3.version].sorted(), "only current and previous stay")
  }

  func testALeasedVersionOutlivesTurningOff() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let linked = try install(folder, version: "1.0.0")
    let lease = "\(pluginStore)/\(linked.version)/.leases/\(getpid())"
    XCTAssertTrue(FileManager.default.createFile(atPath: lease, contents: nil))
    PluginPrograms.withdraw(plugin: "greeter", programs: ["hello-tool"], places: places)
    XCTAssertNil(PluginPrograms.linkTarget(binPath))
    XCTAssertNil(PluginPrograms.linkTarget("\(pluginStore)/current"))
    XCTAssertEqual(versions(), [linked.version], "a running program keeps its version")
    unlink(lease)
    PluginPrograms.sweep(plugin: "greeter", places: places, keepCurrent: false)
    XCTAssertEqual(versions(), [])
  }

  func testALeaseFromAProcessThatIsGoneOrStartedLaterPinsNothing() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let linked = try install(folder, version: "1.0.0")
    let leases = "\(pluginStore)/\(linked.version)/.leases"
    XCTAssertTrue(FileManager.default.createFile(atPath: "\(leases)/999999", contents: nil))
    XCTAssertTrue(FileManager.default.createFile(atPath: "\(leases)/\(getpid())", contents: nil))
    var old = [timespec(tv_sec: 1000, tv_nsec: 0), timespec(tv_sec: 1000, tv_nsec: 0)]
    XCTAssertEqual(utimensat(AT_FDCWD, "\(leases)/\(getpid())", &old, AT_SYMLINK_NOFOLLOW), 0)
    XCTAssertFalse(PluginPrograms.isLeased("\(pluginStore)/\(linked.version)"))
    XCTAssertEqual((try? FileManager.default.contentsOfDirectory(atPath: leases)) ?? ["?"], [], "stale leases are cleared")
  }

  func testTurningOffLeavesALinkSomeoneElseMade() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    _ = try install(folder, version: "1.0.0")
    unlink(binPath)
    XCTAssertEqual(symlink("/usr/bin/true", binPath), 0)
    PluginPrograms.withdraw(plugin: "greeter", programs: ["hello-tool"], places: places)
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "/usr/bin/true")
  }

  func testAFileOrForeignLinkIsNeverReplacedButALegacyLinkIsWhenAdopting() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    try FileManager.default.createDirectory(atPath: places.binDir, withIntermediateDirectories: true)
    try "mine".write(toFile: binPath, atomically: true, encoding: .utf8)
    let refused = try install(folder, version: "1.0.0")
    XCTAssertEqual(refused.linked, [])
    XCTAssertNotNil(refused.refused["hello-tool"])
    XCTAssertEqual(refused.causes["hello-tool"], "taken")
    XCTAssertEqual(try String(contentsOfFile: binPath, encoding: .utf8), "mine")
    unlink(binPath)
    XCTAssertEqual(symlink("/opt/elsewhere/hello-tool", binPath), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, [])
    unlink(binPath)
    XCTAssertEqual(symlink("\(root)/OldCLI/current/bin/hello-tool", binPath), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, [], "a dead old-home link is only taken by the plugin that adopts that home")
    XCTAssertEqual(try install(folder, version: "1.0.0", adopt: true).linked, ["hello-tool"], "the old installer's exact launcher link with no old home behind it is a dead Ardia link, so it's replaced")
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "\(pluginStore)/current/bin/hello")
    unlink(binPath)
    XCTAssertEqual(symlink("\(root)/OldCLI/0.2.41/bin/hello-tool", binPath), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0", adopt: true).linked, [], "a dead link anywhere else under the old home is still someone else's")
    unlink(binPath)
    XCTAssertEqual(symlink("\(root)/OldCLI/current/bin/hello-tool", binPath), 0)
    try FileManager.default.createDirectory(atPath: "\(root)/OldCLI/0.2.41/bin", withIntermediateDirectories: true)
    try "#!/bin/sh\n".write(toFile: "\(root)/OldCLI/0.2.41/bin/hello-tool", atomically: true, encoding: .utf8)
    XCTAssertEqual(symlink("0.2.41", "\(root)/OldCLI/current"), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, [], "only the plugin that adopts the old home may take its link")
    XCTAssertEqual(try install(folder, version: "1.0.0", adopt: true).linked, ["hello-tool"])
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "\(pluginStore)/current/bin/hello")
    unlink(binPath)
    try FileManager.default.createDirectory(atPath: "\(root)/OldCLI/0.2.41/bin", withIntermediateDirectories: true)
    XCTAssertEqual(symlink("\(root)/OldCLI/0.2.41/bin/hello-tool", binPath), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0", adopt: true).linked, [], "only the exact old launcher is taken over, not any path under the old home")
  }

  func testASymlinkedBinFolderYouOwnIsUsed() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let real = "\(root)/dotfiles/bin"
    try FileManager.default.createDirectory(atPath: real, withIntermediateDirectories: true)
    XCTAssertEqual(symlink(real, places.binDir), 0)
    let linked = try install(folder, version: "1.0.0")
    XCTAssertEqual(linked.linked, ["hello-tool"], "a bin folder that's a link to a private folder you own takes the program")
    XCTAssertEqual(PluginPrograms.linkTarget("\(real)/hello-tool"), "\(pluginStore)/current/bin/hello")
    XCTAssertEqual(PluginPrograms.linkTarget(places.binDir), real, "the bin link itself is left as it was")
    XCTAssertEqual(run(binPath), "one")
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, ["hello-tool"], "installing again reuses its own link")
  }

  func testASymlinkedBinFolderOthersCanChangeOrYouDontOwnIsRefused() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let shared = "\(root)/shared/bin"
    try FileManager.default.createDirectory(atPath: shared, withIntermediateDirectories: true)
    XCTAssertEqual(chmod("\(root)/shared", 0o777), 0)
    XCTAssertEqual(symlink(shared, places.binDir), 0)
    let refused = try install(folder, version: "1.0.0")
    XCTAssertEqual(refused.linked, [])
    XCTAssertEqual(refused.causes["hello-tool"], "bin_shared")
    XCTAssertNil(PluginPrograms.linkTarget("\(shared)/hello-tool"))
    unlink(places.binDir)
    XCTAssertEqual(symlink("/usr/bin", places.binDir), 0)
    let foreign = try install(folder, version: "1.0.0")
    XCTAssertEqual(foreign.linked, [])
    XCTAssertEqual(foreign.refused["hello-tool"], "\(places.binDir) isn't a folder you own")
    XCTAssertEqual(foreign.causes["hello-tool"], "bin_folder")
    unlink(places.binDir)
    XCTAssertEqual(symlink("\(root)/missing", places.binDir), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0").causes["hello-tool"], "bin_folder", "a dangling bin link isn't followed or replaced")
    XCTAssertEqual(PluginPrograms.linkTarget(places.binDir), "\(root)/missing")
  }

  func testABinLinkRedirectedThroughAFolderOthersCanChangeIsRefusedEvenWhenItEndsSomewherePrivate() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let mine = "\(root)/private"
    try FileManager.default.createDirectory(atPath: "\(mine)/bin", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: "\(root)/shared", withIntermediateDirectories: true)
    XCTAssertEqual(chmod("\(root)/shared", 0o777), 0)
    XCTAssertEqual(symlink(mine, "\(root)/shared/redirect"), 0)
    XCTAssertEqual(symlink("\(root)/shared/redirect/bin", places.binDir), 0)
    let refused = try install(folder, version: "1.0.0")
    XCTAssertEqual(refused.linked, [])
    XCTAssertEqual(refused.causes["hello-tool"], "bin_shared", "another user could swap the redirect, so it isn't followed")
    XCTAssertNil(PluginPrograms.linkTarget("\(mine)/bin/hello-tool"))
    XCTAssertEqual(chmod("\(root)/shared", 0o755), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, ["hello-tool"], "the same chain through folders only you can change is followed")
    XCTAssertEqual(PluginPrograms.linkTarget("\(mine)/bin/hello-tool"), "\(pluginStore)/current/bin/hello")
  }

  func testABinFolderOthersCanWriteIsRefusedEvenWithItsStickyBit() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    try FileManager.default.createDirectory(atPath: places.binDir, withIntermediateDirectories: true)
    for mode in [mode_t(0o1777), 0o1775, 0o775, 0o757] {
      XCTAssertEqual(chmod(places.binDir, mode), 0)
      let refused = try install(folder, version: "1.0.0")
      XCTAssertEqual(refused.linked, [], String(mode, radix: 8))
      XCTAssertEqual(refused.causes["hello-tool"], "bin_shared", String(mode, radix: 8))
      XCTAssertNil(PluginPrograms.linkTarget(binPath))
    }
    XCTAssertEqual(chmod(places.binDir, 0o755), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, ["hello-tool"])
  }

  func testALiveOldHomeReachedThroughASymlinkIsNeverOverwritten() throws {
    let real = "\(root)/RealCLI"
    try FileManager.default.createDirectory(atPath: "\(real)/0.2.41/bin", withIntermediateDirectories: true)
    try "#!/bin/sh\necho old\n".write(toFile: "\(real)/0.2.41/bin/hello-tool", atomically: true, encoding: .utf8)
    XCTAssertEqual(chmod("\(real)/0.2.41/bin/hello-tool", 0o755), 0)
    XCTAssertEqual(symlink("0.2.41", "\(real)/current"), 0)
    XCTAssertEqual(symlink(real, "\(root)/OldCLI"), 0)
    try FileManager.default.createDirectory(atPath: places.binDir, withIntermediateDirectories: true)
    XCTAssertEqual(symlink("\(root)/OldCLI/current/bin/hello-tool", binPath), 0)
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let refused = try install(folder, version: "1.0.0", adopt: true)
    XCTAssertEqual(refused.linked, [], "the old home can't be adopted through a link, and its launcher still runs, so it isn't dead")
    XCTAssertEqual(refused.causes["hello-tool"], "taken")
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "\(root)/OldCLI/current/bin/hello-tool")
    XCTAssertEqual(run(binPath), "old")
  }

  func testALinkIntoTheStoreThatCantBeCheckedIsntTakenForDead() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    try FileManager.default.createDirectory(atPath: "\(places.store)/locked/current/bin", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: places.binDir, withIntermediateDirectories: true)
    XCTAssertEqual(symlink("\(places.store)/locked/current/bin/hello", binPath), 0)
    XCTAssertEqual(chmod("\(places.store)/locked", 0o000), 0)
    defer { chmod("\(places.store)/locked", 0o755) }
    var info = stat()
    XCTAssertNotEqual(stat(binPath, &info), 0)
    XCTAssertEqual(errno, EACCES)
    let refused = try install(folder, version: "1.0.0")
    XCTAssertEqual(refused.linked, [], "EACCES isn't proof the target is gone")
    XCTAssertEqual(refused.causes["hello-tool"], "other_plugin")
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "\(places.store)/locked/current/bin/hello")
  }

  func testARelativeLinkIsResolvedFromTheBinFolderNotArdiasWorkingFolder() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    _ = try install(folder, version: "1.0.0")
    unlink(binPath)
    XCTAssertEqual(symlink("greeter/current/bin/hello", binPath), 0)
    let before = FileManager.default.currentDirectoryPath
    XCTAssertTrue(FileManager.default.changeCurrentDirectoryPath(places.store))
    defer { FileManager.default.changeCurrentDirectoryPath(before) }
    let refused = try install(folder, version: "1.0.0")
    XCTAssertEqual(refused.linked, [], "from the bin folder it leads nowhere Ardia made, whatever the working folder")
    XCTAssertEqual(refused.causes["hello-tool"], "taken")
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "greeter/current/bin/hello")
  }

  func testMissingBinFoldersAreMadeOnlyUnderFoldersThatAreChecked() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    places = ProgramPlaces(store: places.store, binDir: "\(root)/home/a/b/bin")
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, ["hello-tool"], "missing folders under private ones are made, one by one")
    var info = stat()
    XCTAssertEqual(lstat("\(root)/home/a/b/bin", &info), 0)
    XCTAssertEqual(info.st_uid, geteuid())
    XCTAssertEqual(PluginPrograms.linkTarget("\(root)/home/a/b/bin/hello-tool"), "\(pluginStore)/current/bin/hello")

    try FileManager.default.createDirectory(atPath: "\(root)/shared", withIntermediateDirectories: true)
    XCTAssertEqual(chmod("\(root)/shared", 0o777), 0)
    places = ProgramPlaces(store: places.store, binDir: "\(root)/shared/new/bin")
    XCTAssertEqual(try install(folder, version: "1.0.0").causes["hello-tool"], "bin_shared")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/shared/new"), "nothing is made inside a folder other users can change")

    let foreign = "/usr/ardia-test-\(UUID().uuidString)"
    places = ProgramPlaces(store: places.store, binDir: "\(foreign)/bin")
    XCTAssertEqual(try install(folder, version: "1.0.0").causes["hello-tool"], "bin_folder")
    XCTAssertFalse(FileManager.default.fileExists(atPath: foreign))
  }

  func testAPathIsSplitOnSlashBytesSoACombiningMarkCantHideAFolder() throws {
    XCTAssertEqual(BinFolder.components(Array("/a/\u{0301}b".utf8)), [Array("a".utf8), Array("\u{0301}b".utf8)])
    XCTAssertTrue("/a/\u{0301}b".split(separator: "/").contains { $0.utf8.contains(0x2F) }, "Swift's own split keeps the slash inside the mark's character")
    XCTAssertNil(BinFolder.components([0x2F, 0x61, 0x00, 0x62]), "a NUL byte is refused")
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let hidden = "\(root)/shared/\u{0301}evil"
    try FileManager.default.createDirectory(atPath: "\(hidden)/bin", withIntermediateDirectories: true)
    XCTAssertEqual(chmod("\(root)/shared", 0o777), 0)
    places = ProgramPlaces(store: places.store, binDir: "\(hidden)/bin")
    let refused = try install(folder, version: "1.0.0")
    XCTAssertEqual(refused.causes["hello-tool"], "bin_shared", "the shared folder before the mark is checked like any other")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(hidden)/bin/hello-tool"))
  }

  func testTheBinFolderDescriptorIsClosedOnExec() throws {
    try FileManager.default.createDirectory(atPath: places.binDir, withIntermediateDirectories: true)
    let bin = try BinFolder.open(places.binDir, creating: false).get()
    let flags = fcntl(bin.fd, F_GETFD)
    XCTAssertGreaterThanOrEqual(flags, 0, "the descriptor is open")
    XCTAssertNotEqual(flags & FD_CLOEXEC, 0, "a program Ardia starts never inherits it")
  }

  func testADeadLinkThatEscapesTheStoreIsntTakenForArdias() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    try FileManager.default.createDirectory(atPath: places.binDir, withIntermediateDirectories: true)
    for escaping in ["\(places.store)/../outside", "\(places.store)/gone/current/../../../outside/hello", "\(places.store)/greeter/current/../../../outside", "\(places.store)//gone/current/bin/hello"] {
      unlink(binPath)
      XCTAssertEqual(symlink(escaping, binPath), 0)
      XCTAssertEqual(try install(folder, version: "1.0.0").linked, [], escaping)
      XCTAssertEqual(PluginPrograms.linkTarget(binPath), escaping, "only the exact launcher shape Ardia makes is its own")
    }
    XCTAssertFalse(PluginPrograms.isLauncherPath("\(places.store)/../outside", in: places.store))
    XCTAssertTrue(PluginPrograms.isLauncherPath("\(places.store)/gone/current/bin/hello", in: places.store))
    XCTAssertFalse(PluginPrograms.isLauncherPath("\(places.store)/gone/1.0.0-abc/bin/hello", in: places.store))
  }

  func rawLink(_ target: [UInt8], at path: String) -> Int32 {
    (target.map { CChar(bitPattern: $0) } + [0]).withUnsafeBufferPointer { symlink($0.baseAddress!, path) }
  }

  func rawTarget(_ path: String) -> [UInt8] {
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
    let count = readlink(path, &buffer, Int(PATH_MAX))
    return count > 0 ? buffer[0..<count].map { UInt8(bitPattern: $0) } : []
  }

  func testOnlyAnExactPluginIdInValidUTF8MakesALinkArdias() throws {
    XCTAssertFalse(PluginPrograms.isName("greeter\n"), "a trailing newline isn't part of a name")
    XCTAssertTrue(PluginPrograms.isName("greeter"))
    let store = Array("\(places.store)/".utf8)
    let newline = store + Array("gone\n/current/bin/hello".utf8)
    let invalid = store + [0x67, 0xFF, 0x6F] + Array("/current/bin/hello".utf8)
    let overlong = store + [0x67, 0xC0, 0xAF] + Array("/current/bin/hello".utf8)
    for bytes in [newline, invalid, overlong] { XCTAssertNil(PluginPrograms.launcherOwner(bytes, in: places.store)) }
    XCTAssertEqual(PluginPrograms.launcherOwner(store + Array("gone/current/bin/hello".utf8), in: places.store), "gone")
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    try FileManager.default.createDirectory(atPath: places.binDir, withIntermediateDirectories: true)
    for bytes in [newline, invalid] {
      unlink(binPath)
      XCTAssertEqual(rawLink(bytes, at: binPath), 0)
      XCTAssertEqual(try install(folder, version: "1.0.0").linked, [])
      XCTAssertEqual(rawTarget(binPath), bytes, "the link is left byte for byte")
    }
  }

  func testCleanupRemovesOnlyThisPluginsExactLaunchers() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, ["hello-tool"])
    let left = [
      "escape-up": "\(pluginStore)/../../outside",
      "escape-in": "\(pluginStore)/current/../../../outside",
      "prefix": "\(places.store)/greeterx/current/bin/hello",
      "doubled": "\(places.store)//greeter/current/bin/hello",
    ]
    for (name, target) in left { XCTAssertEqual(symlink(target, "\(places.binDir)/\(name)"), 0) }
    XCTAssertEqual(rawLink(Array("\(pluginStore)\n/current/bin/hello".utf8), at: "\(places.binDir)/newline"), 0)
    PluginPrograms.withdraw(plugin: "greeter", programs: ["hello-tool"], places: places)
    XCTAssertNil(PluginPrograms.linkTarget(binPath), "its own launcher goes")
    for (name, target) in left { XCTAssertEqual(PluginPrograms.linkTarget("\(places.binDir)/\(name)"), target, name) }
    XCTAssertEqual(rawTarget("\(places.binDir)/newline"), Array("\(pluginStore)\n/current/bin/hello".utf8))
  }

  func testADeadLinkIntoArdiasOwnStoreIsReplaced() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    try FileManager.default.createDirectory(atPath: places.binDir, withIntermediateDirectories: true)
    XCTAssertEqual(symlink("\(places.store)/gone/current/bin/hello", binPath), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, ["hello-tool"], "a link Ardia made for a plugin that's gone is Ardia's to replace")
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "\(pluginStore)/current/bin/hello")
  }

  func testALinkSpelledThroughAnotherPathToTheSameProgramIsReused() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    _ = try install(folder, version: "1.0.0")
    XCTAssertEqual(symlink(places.store, "\(root)/store-alias"), 0)
    unlink(binPath)
    XCTAssertEqual(symlink("\(root)/store-alias/greeter/current/bin/hello", binPath), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, ["hello-tool"])
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "\(pluginStore)/current/bin/hello")
  }

  func testAnotherPluginsProgramIsNamedNotTaken() throws {
    let first = try makePlugin("greeter", version: "1.0.0", say: "one")
    _ = try install(first, version: "1.0.0")
    let second = try makePlugin("waver", version: "1.0.0", say: "two")
    let linked = try install(second, plugin: "waver", version: "1.0.0")
    XCTAssertEqual(linked.linked, [])
    XCTAssertEqual(linked.refused["hello-tool"], "hello-tool comes from the greeter plugin; turn that one off to use this one")
    PluginPrograms.withdraw(plugin: "greeter", programs: ["hello-tool"], places: places)
    XCTAssertEqual(try install(second, plugin: "waver", version: "1.0.0").linked, ["hello-tool"])
    XCTAssertEqual(run(binPath), "two")
  }

  func testAnyLinkSpecialFileOrReservedNameIsRefused() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    for target in ["../../../../etc/passwd", "/etc/passwd", "hello"] {
      XCTAssertEqual(symlink(target, "\(folder)/bin/link"), 0)
      XCTAssertThrowsError(try install(folder, version: "1.0.0"), target)
      unlink("\(folder)/bin/link")
    }
    XCTAssertEqual(mkfifo("\(folder)/pipe", 0o600), 0)
    XCTAssertThrowsError(try install(folder, version: "1.0.0"))
    unlink("\(folder)/pipe")
    try FileManager.default.createDirectory(atPath: "\(folder)/.leases", withIntermediateDirectories: true)
    XCTAssertThrowsError(try install(folder, version: "1.0.0"))
    try FileManager.default.removeItem(atPath: "\(folder)/.leases")
    XCTAssertEqual(versions().count, 0, "refused copies leave nothing behind")
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, ["hello-tool"])
  }

  func testTheCopyIsMadeThroughTheOpenedFolderWithModesTrimmed() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    XCTAssertEqual(chmod("\(folder)/bin/hello", 0o4777), 0)
    let opened = try XCTUnwrap(PluginFiles.openFolder(folder))
    defer { opened.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: opened) else { return XCTFail("no manifest") }
    let approved = PluginFiles.approvalHash(text: text, folderId: opened.id)
    try FileManager.default.moveItem(atPath: folder, toPath: "\(root)/plugins/moved")
    try FileManager.default.createDirectory(atPath: "\(folder)/bin", withIntermediateDirectories: true)
    try "#!/bin/sh\necho swapped\n".write(toFile: "\(folder)/bin/hello", atomically: true, encoding: .utf8)
    let linked = try PluginPrograms.install(plugin: "greeter", from: opened, approved: approved, version: "1.0.0", programs: [tool], places: places).get()
    XCTAssertEqual(linked.linked, ["hello-tool"])
    XCTAssertEqual(run(binPath), "one", "a folder put at the old path after approval is never read")
    var info = stat()
    XCTAssertEqual(stat("\(pluginStore)/current/bin/hello", &info), 0)
    XCTAssertEqual(info.st_mode & 0o7777, 0o555, "trimmed, then sealed read-only once it verified")
  }

  func testAdoptingTheOldHomeRepointsItsCurrentAndClearsItsUnusedVersions() throws {
    let legacy = "\(root)/OldCLI"
    for version in ["0.2.40", "0.2.41"] { try FileManager.default.createDirectory(atPath: "\(legacy)/\(version)/bin", withIntermediateDirectories: true) }
    try "#!/bin/sh\n".write(toFile: "\(legacy)/0.2.41/bin/hello-tool", atomically: true, encoding: .utf8)
    try FileManager.default.createDirectory(atPath: "\(legacy)/0.2.40/.leases", withIntermediateDirectories: true)
    XCTAssertTrue(FileManager.default.createFile(atPath: "\(legacy)/0.2.40/.leases/\(getpid())", contents: nil))
    try FileManager.default.createDirectory(atPath: "\(legacy)/cua-driver", withIntermediateDirectories: true)
    try "{}".write(toFile: "\(legacy)/usage.json", atomically: true, encoding: .utf8)
    XCTAssertEqual(symlink("0.2.41", "\(legacy)/current"), 0)
    try FileManager.default.createDirectory(atPath: places.binDir, withIntermediateDirectories: true)
    XCTAssertEqual(symlink("\(legacy)/current/bin/hello-tool", binPath), 0)
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let linked = try install(folder, version: "1.0.0", adopt: true)
    XCTAssertTrue(linked.adopted)
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "\(pluginStore)/current/bin/hello", "one ardia on PATH, Ardia's")
    XCTAssertEqual(PluginPrograms.linkTarget("\(legacy)/current"), "\(pluginStore)/current")
    XCTAssertEqual(run("\(legacy)/current/bin/hello"), "one", "paths saved through the old home keep working")
    let left = try FileManager.default.contentsOfDirectory(atPath: legacy).sorted()
    XCTAssertEqual(left, [".lock", "0.2.40", "cua-driver", "current", "usage.json"], "a running old version and the home's own state stay")
    let again = try install(folder, version: "1.0.0", adopt: true)
    XCTAssertFalse(again.adopted, "adopting twice changes nothing")
    XCTAssertEqual(again.adoption, .already, "and says it was already Ardia's")
  }

  func testAfterUpdateIsMarkedPerVersion() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let linked = try install(folder, version: "1.0.0")
    XCTAssertTrue(PluginPrograms.needsAfterUpdate(plugin: "greeter", version: linked.version, places: places))
    PluginPrograms.markAfterUpdate(plugin: "greeter", version: linked.version, places: places)
    XCTAssertFalse(PluginPrograms.needsAfterUpdate(plugin: "greeter", version: linked.version, places: places))
    XCTAssertTrue(PluginPrograms.isCurrent(plugin: "greeter", version: linked.version, places: places))
    let digest = PluginPrograms.payloadDigest("\(pluginStore)/\(linked.version)")
    XCTAssertEqual(digest, PluginPrograms.payloadDigest(folder), "the marker and leases aren't part of the payload")
  }

  func testAManifestChangedAfterApprovalIsRefused() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let opened = try XCTUnwrap(PluginFiles.openFolder(folder))
    defer { opened.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: opened) else { return XCTFail("no manifest") }
    let approved = PluginFiles.approvalHash(text: text, folderId: opened.id)
    try #"{"name": "greeter", "version": "1.0.0", "programs": [{"name": "hello-tool", "path": "bin/hello"}], "permissions": ["network"]}"#.write(toFile: "\(folder)/plugin.json", atomically: false, encoding: .utf8)
    let result = PluginPrograms.install(plugin: "greeter", from: opened, approved: approved, version: "1.0.0", programs: [tool], places: places)
    guard case .failure(let refusal) = result else { return XCTFail("a changed manifest installed") }
    XCTAssertEqual(refusal.reason, "its plugin.json changed since you approved it")
    XCTAssertNil(PluginPrograms.linkTarget(binPath))
  }

  func testAMissingOrNonExecutableProgramIsRefused() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    XCTAssertEqual(chmod("\(folder)/bin/hello", 0o644), 0)
    XCTAssertThrowsError(try install(folder, version: "1.0.0"))
  }

  func testRemoveDeletesTheStoreOnceNothingIsLeased() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    _ = try install(folder, version: "1.0.0")
    XCTAssertTrue(PluginPrograms.remove(plugin: "greeter", programs: ["hello-tool"], places: places))
    XCTAssertFalse(FileManager.default.fileExists(atPath: pluginStore))
    XCTAssertNil(PluginPrograms.linkTarget(binPath))
  }

  func testThePayloadDigestIsTheOneTheReleaseScriptComputes() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    try FileManager.default.createDirectory(atPath: "\(folder)/lib/empty", withIntermediateDirectories: true)
    try "data".write(toFile: "\(folder)/lib/zz.txt", atomically: true, encoding: .utf8)
    let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../scripts/release/plugin-digest.py").standardized.path
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    process.arguments = [script, folder]
    let pipe = Pipe()
    process.standardOutput = pipe
    try process.run()
    process.waitUntilExit()
    let printed = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    XCTAssertEqual(process.terminationStatus, 0)
    XCTAssertEqual(PluginPrograms.payloadDigest(folder), printed)
    XCTAssertEqual(printed.count, 64)
  }

  func testTheHostContractWithAFakeBuiltInInstallRunUninstall() throws {
    let folder = try makePlugin("greeter", version: "2.1.0", say: "contract")
    let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../scripts/release/plugin-digest.py").standardized.path
    let digest = Process()
    digest.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    digest.arguments = [script, folder]
    let pipe = Pipe()
    digest.standardOutput = pipe
    try digest.run()
    digest.waitUntilExit()
    let signed = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    let opened = try XCTUnwrap(PluginFiles.openFolder(folder))
    defer { opened.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: opened) else { return XCTFail("no manifest") }
    let approved = PluginFiles.approvalHash(text: text, folderId: opened.id)
    let installed = try PluginPrograms.install(plugin: "greeter", from: opened, approved: approved, version: "2.1.0", programs: [tool], places: places, expectedDigest: signed).get()
    XCTAssertEqual(installed.linked, ["hello-tool"])
    XCTAssertEqual(run(binPath), "contract", "the program runs from the store through its PATH link")
    XCTAssertTrue(PluginPrograms.remove(plugin: "greeter", programs: ["hello-tool"], places: places))
    XCTAssertNil(PluginPrograms.linkTarget(binPath))
    XCTAssertFalse(FileManager.default.fileExists(atPath: binPath))
    XCTAssertFalse(FileManager.default.fileExists(atPath: pluginStore))
  }

  func testABuiltInWhoseFilesDontMatchItsSignedDigestIsRefused() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let signed = try XCTUnwrap(PluginPrograms.payloadDigest(folder))
    try "#!/bin/sh\necho swapped\n".write(toFile: "\(folder)/bin/hello", atomically: true, encoding: .utf8)
    let opened = try XCTUnwrap(PluginFiles.openFolder(folder))
    defer { opened.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: opened) else { return XCTFail("no manifest") }
    let approved = PluginFiles.approvalHash(text: text, folderId: opened.id)
    let result = PluginPrograms.install(plugin: "greeter", from: opened, approved: approved, version: "1.0.0", programs: [tool], places: places, expectedDigest: signed)
    guard case .failure(let refusal) = result else { return XCTFail("a changed payload installed") }
    XCTAssertEqual(refusal.reason, "its files don't match the ones Ardia downloaded and checked")
    XCTAssertEqual(versions(), [])
    XCTAssertNil(PluginPrograms.linkTarget(binPath))
    XCTAssertEqual(chmod("\(folder)/bin/hello", 0o755), 0)
    let current = try XCTUnwrap(PluginPrograms.payloadDigest(folder))
    XCTAssertEqual(try PluginPrograms.install(plugin: "greeter", from: opened, approved: approved, version: "1.0.0", programs: [tool], places: places, expectedDigest: current).get().linked, ["hello-tool"])
  }

  func testAProgramThatWouldHideASystemCommandIsntLinked() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    try FileManager.default.createDirectory(atPath: "\(root)/system", withIntermediateDirectories: true)
    try "#!/bin/sh\n".write(toFile: "\(root)/system/hello-tool", atomically: true, encoding: .utf8)
    XCTAssertEqual(chmod("\(root)/system/hello-tool", 0o755), 0)
    places.shadowable = ["\(root)/system"]
    let linked = try install(folder, version: "1.0.0")
    XCTAssertEqual(linked.linked, [])
    XCTAssertEqual(linked.refused["hello-tool"], "hello-tool would hide \(root)/system/hello-tool, so it isn't put on PATH")
    XCTAssertNil(PluginPrograms.linkTarget(binPath))
  }

  func testPythonCachesAreNeitherCopiedNorHashedAndACacheWrittenLaterKeepsTheCopy() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    try FileManager.default.createDirectory(atPath: "\(folder)/lib/__pycache__", withIntermediateDirectories: true)
    try "planted".write(toFile: "\(folder)/lib/__pycache__/x.pyc", atomically: true, encoding: .utf8)
    let signed = PluginPrograms.payloadDigest(folder)
    try FileManager.default.removeItem(atPath: "\(folder)/lib/__pycache__")
    XCTAssertEqual(PluginPrograms.payloadDigest(folder), signed, "caches don't count")
    try FileManager.default.createDirectory(atPath: "\(folder)/lib/__pycache__", withIntermediateDirectories: true)
    try "planted".write(toFile: "\(folder)/lib/__pycache__/x.pyc", atomically: true, encoding: .utf8)
    let linked = try install(folder, version: "1.0.0")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(pluginStore)/\(linked.version)/lib/__pycache__"), "a cache in the source is never copied")
    XCTAssertEqual(chmod("\(pluginStore)/\(linked.version)/lib", 0o755), 0)
    try FileManager.default.createDirectory(atPath: "\(pluginStore)/\(linked.version)/lib/__pycache__", withIntermediateDirectories: true)
    try "written by python".write(toFile: "\(pluginStore)/\(linked.version)/lib/__pycache__/y.pyc", atomically: true, encoding: .utf8)
    let again = try install(folder, version: "1.0.0")
    XCTAssertEqual(again.version, linked.version)
    XCTAssertFalse(again.fresh, "a cache Python wrote into the copy doesn't make Ardia replace it")
  }

  func testACopyThatNoLongerVerifiesIsReplacedUnderANewNameAndTheOldOneIsKeptWhileLeased() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let first = try install(folder, version: "1.0.0")
    XCTAssertTrue(FileManager.default.createFile(atPath: "\(pluginStore)/\(first.version)/.leases/\(getpid())", contents: nil))
    XCTAssertEqual(chmod("\(pluginStore)/\(first.version)/bin/hello", 0o777), 0)
    let second = try install(folder, version: "1.0.0")
    XCTAssertTrue(second.fresh)
    XCTAssertNotEqual(second.version, first.version)
    XCTAssertTrue(second.version.hasPrefix(first.version + "-r"))
    XCTAssertTrue(FileManager.default.fileExists(atPath: "\(pluginStore)/\(first.version)/bin/hello"), "a running copy is never pulled away")
    XCTAssertEqual(run(binPath), "one")
    unlink("\(pluginStore)/\(first.version)/.leases/\(getpid())")
    let third = try install(folder, version: "1.0.0")
    XCTAssertEqual(third.version, second.version, "the replacement is reused")
    XCTAssertFalse(third.fresh)
  }

  func testHardLinksAreRefused() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    XCTAssertEqual(link("\(folder)/bin/hello", "\(folder)/bin/twin"), 0)
    XCTAssertThrowsError(try install(folder, version: "1.0.0"))
  }

  func testLaunchSweepTakesOffCommandsOfPluginsThatAreGone() throws {
    let kept = try makePlugin("greeter", version: "1.0.0", say: "one")
    _ = try install(kept, version: "1.0.0")
    let gone = try makePlugin("waver", version: "1.0.0", say: "two")
    let waver = try PluginPrograms.install(
      plugin: "waver", from: try XCTUnwrap(PluginFiles.openFolder(gone)), approved: approval(gone), version: "1.0.0", programs: [PluginProgram(name: "wave-tool", path: "bin/hello")], places: places
    ).get()
    XCTAssertEqual(waver.linked, ["wave-tool"])
    try FileManager.default.removeItem(atPath: gone)
    PluginPrograms.withdrawAllBut(["greeter"], places: places)
    XCTAssertNil(PluginPrograms.linkTarget("\(places.binDir)/wave-tool"))
    XCTAssertNil(PluginPrograms.linkTarget("\(places.store)/waver/current"))
    XCTAssertEqual(run(binPath), "one")
  }

  func testDroppingACommandTakesItsLinkOff() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let two = [tool, PluginProgram(name: "hello-two", path: "bin/hello")]
    _ = try PluginPrograms.install(plugin: "greeter", from: try XCTUnwrap(PluginFiles.openFolder(folder)), approved: approval(folder), version: "1.0.0", programs: two, places: places).get()
    XCTAssertNotNil(PluginPrograms.linkTarget("\(places.binDir)/hello-two"))
    _ = try install(folder, version: "1.0.0")
    XCTAssertNil(PluginPrograms.linkTarget("\(places.binDir)/hello-two"))
    XCTAssertNotNil(PluginPrograms.linkTarget(binPath))
  }

  func testAdoptionWaitsForTheOldInstaller() throws {
    let legacy = "\(root)/OldCLI"
    try FileManager.default.createDirectory(atPath: "\(legacy)/0.2.41/bin", withIntermediateDirectories: true)
    try "#!/bin/sh\n".write(toFile: "\(legacy)/0.2.41/bin/hello-tool", atomically: true, encoding: .utf8)
    XCTAssertEqual(symlink("0.2.41", "\(legacy)/current"), 0)
    try FileManager.default.createDirectory(atPath: places.binDir, withIntermediateDirectories: true)
    XCTAssertEqual(symlink("\(legacy)/current/bin/hello-tool", binPath), 0)
    let held = open("\(legacy)/.lock", O_RDWR | O_CREAT, 0o644)
    XCTAssertEqual(flock(held, LOCK_EX), 0)
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let busy = try install(folder, version: "1.0.0", adopt: true)
    XCTAssertFalse(busy.adopted)
    XCTAssertTrue(busy.adoptBusy, "a held lock is reported, so Ardia tries again")
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "\(legacy)/current/bin/hello-tool", "the PATH link isn't taken while the old installer holds its lock")
    XCTAssertEqual(busy.linked, [])
    XCTAssertNil(busy.refused["hello-tool"], "a busy old install isn't reported as someone else's link")
    XCTAssertEqual(PluginPrograms.linkTarget("\(legacy)/current"), "0.2.41", "an install in progress is left alone")
    XCTAssertTrue(FileManager.default.fileExists(atPath: "\(legacy)/0.2.41"))
    close(held)
    XCTAssertTrue(try install(folder, version: "1.0.0", adopt: true).adopted)
    XCTAssertEqual(PluginPrograms.linkTarget(binPath), "\(pluginStore)/current/bin/hello", "the PATH link and current change together, under the lock")
  }

  func testAfterUpdateIsClaimedByOneProcessAtATime() throws {
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    let linked = try install(folder, version: "1.0.0")
    XCTAssertTrue(PluginPrograms.claimAfterUpdate(plugin: "greeter", version: linked.version, places: places))
    XCTAssertFalse(PluginPrograms.claimAfterUpdate(plugin: "greeter", version: linked.version, places: places), "a live claim holds")
    PluginPrograms.releaseAfterUpdate(plugin: "greeter", version: linked.version, places: places)
    try "999999\n".write(toFile: "\(pluginStore)/\(linked.version)/.after-update-claim", atomically: true, encoding: .utf8)
    XCTAssertTrue(PluginPrograms.claimAfterUpdate(plugin: "greeter", version: linked.version, places: places), "a claim from a process that's gone is taken over")
    XCTAssertEqual(PluginPrograms.whileCurrent(plugin: "greeter", version: linked.version, places: places) { 1 }, 1)
    XCTAssertNil(PluginPrograms.whileCurrent(plugin: "greeter", version: "other", places: places) { 1 })
  }

  func approval(_ folder: String) throws -> String {
    let opened = try XCTUnwrap(PluginFiles.openFolder(folder))
    defer { opened.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: opened) else { throw XCTSkip("no manifest") }
    return PluginFiles.approvalHash(text: text, folderId: opened.id)
  }

  func testVersionFolderNamesAreSafe() {
    XCTAssertEqual(PluginPrograms.versionFolderName(version: "1.2.3-nightly.4", approved: String(repeating: "ab", count: 32)), "1.2.3-nightly.4-abababababab")
    XCTAssertEqual(PluginPrograms.versionFolderName(version: "../../x", approved: "0123456789abcdef"), "x-0123456789ab")
    XCTAssertEqual(PluginPrograms.versionFolderName(version: nil, approved: "0123456789abcdef"), "0.0.0-0123456789ab")
  }
}

extension PluginProgramsTests {
  func testAdoptionNeverFollowsALinkedFolderAndPrunesOnlyInsideTheOldHome() throws {
    let elsewhere = "\(root)/elsewhere"
    try FileManager.default.createDirectory(atPath: "\(elsewhere)/0.2.41/bin", withIntermediateDirectories: true)
    try "#!/bin/sh\n".write(toFile: "\(elsewhere)/0.2.41/bin/hello-tool", atomically: true, encoding: .utf8)
    XCTAssertEqual(symlink("0.2.41", "\(elsewhere)/current"), 0)
    XCTAssertEqual(symlink(elsewhere, "\(root)/OldCLI"), 0)
    XCTAssertFalse(PluginPrograms.legacyInstalled(oldHome), "a linked old home isn't one")
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    XCTAssertEqual(try install(folder, version: "1.0.0", adopt: true).adoption, .none)
    XCTAssertEqual(PluginPrograms.linkTarget("\(elsewhere)/current"), "0.2.41", "nothing through the link changes")
    XCTAssertTrue(FileManager.default.fileExists(atPath: "\(elsewhere)/0.2.41"))
  }

  func testAnOldHomeWhoseCurrentPointsOutsideItIsntTakenOver() throws {
    try FileManager.default.createDirectory(atPath: "\(root)/OldCLI", withIntermediateDirectories: true)
    XCTAssertEqual(symlink("/usr/bin", "\(root)/OldCLI/current"), 0)
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    XCTAssertEqual(try install(folder, version: "1.0.0", adopt: true).adoption, .none)
    XCTAssertEqual(PluginPrograms.linkTarget("\(root)/OldCLI/current"), "/usr/bin")
  }
}

extension PluginProgramsTests {
  func testAnUpdateWhileTheOldInstallerHoldsItsLockChangesNoLinkAndRunsNoAfterUpdate() throws {
    let legacy = "\(root)/OldCLI"
    try FileManager.default.createDirectory(atPath: "\(legacy)/0.2.41/bin", withIntermediateDirectories: true)
    try "#!/bin/sh\n".write(toFile: "\(legacy)/0.2.41/bin/hello-tool", atomically: true, encoding: .utf8)
    XCTAssertEqual(symlink("0.2.41", "\(legacy)/current"), 0)
    let first = try makePlugin("greeter", version: "1.0.0", say: "one")
    XCTAssertEqual(try install(first, version: "1.0.0", adopt: true).adoption, .adopted)
    let adoptedCurrent = PluginPrograms.linkTarget("\(pluginStore)/current")
    XCTAssertEqual(run(binPath), "one")
    try FileManager.default.removeItem(atPath: first)
    let second = try makePlugin("greeter", version: "2.0.0", say: "two")
    let held = open("\(legacy)/.lock", O_RDWR | O_CREAT, 0o644)
    XCTAssertEqual(flock(held, LOCK_EX), 0)
    let busy = try install(second, version: "2.0.0", adopt: true)
    XCTAssertTrue(busy.adoptBusy)
    XCTAssertEqual(PluginPrograms.linkTarget("\(pluginStore)/current"), adoptedCurrent, "Ardia's own current isn't switched while the old installer holds its lock")
    XCTAssertEqual(PluginPrograms.linkTarget("\(legacy)/current"), "\(pluginStore)/current")
    XCTAssertEqual(run(binPath), "one", "what PATH runs is unchanged")
    XCTAssertFalse(PluginPrograms.shouldRunAfterUpdate(busy, plugin: "greeter", places: places), "no afterUpdate starts on a busy result")
    close(held)
    let done = try install(second, version: "2.0.0", adopt: true)
    XCTAssertEqual(done.adoption, .already)
    XCTAssertEqual(run(binPath), "two")
    XCTAssertTrue(PluginPrograms.shouldRunAfterUpdate(done, plugin: "greeter", places: places))
  }
}
