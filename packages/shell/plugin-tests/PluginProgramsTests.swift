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
    places = ProgramPlaces(store: "\(root)/Programs", binDir: "\(root)/bin", legacy: "\(root)/OldCLI")
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

  func install(_ folder: String, plugin: String = "greeter", version: String, adopt: Bool = false) throws -> ProgramsLinked {
    let opened = try XCTUnwrap(PluginFiles.openFolder(folder))
    defer { opened.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: opened) else { throw XCTSkip("no manifest") }
    let approved = PluginFiles.approvalHash(text: text, folderId: opened.id)
    return try PluginPrograms.install(plugin: plugin, from: opened, approved: approved, version: version, programs: [tool], places: places, adopt: adopt).get()
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
      let elsewhere = ProgramPlaces(store: "\(root)/\(store)", binDir: "\(root)/bin-\(store)", legacy: nil)
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
    XCTAssertEqual(try String(contentsOfFile: binPath, encoding: .utf8), "mine")
    unlink(binPath)
    XCTAssertEqual(symlink("/opt/elsewhere/hello-tool", binPath), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, [])
    unlink(binPath)
    XCTAssertEqual(symlink("\(root)/OldCLI/current/bin/hello-tool", binPath), 0)
    XCTAssertEqual(try install(folder, version: "1.0.0").linked, [], "only the plugin that adopts the old home may take its link")
    XCTAssertEqual(try install(folder, version: "1.0.0", adopt: true).linked, ["hello-tool"])
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
    XCTAssertEqual(info.st_mode & 0o7777, 0o755)
  }

  func testAdoptingTheOldHomeRepointsItsCurrentAndClearsItsUnusedVersions() throws {
    let legacy = "\(root)/OldCLI"
    for version in ["0.2.40", "0.2.41"] { try FileManager.default.createDirectory(atPath: "\(legacy)/\(version)/bin", withIntermediateDirectories: true) }
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
    XCTAssertFalse(try install(folder, version: "1.0.0", adopt: true).adopted, "adopting twice changes nothing")
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
    XCTAssertEqual(refusal.reason, "its files don't match the ones this Ardia was signed with")
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
    XCTAssertEqual(symlink("0.2.41", "\(legacy)/current"), 0)
    let held = open("\(legacy)/.lock", O_RDWR | O_CREAT, 0o644)
    XCTAssertEqual(flock(held, LOCK_EX), 0)
    let folder = try makePlugin("greeter", version: "1.0.0", say: "one")
    XCTAssertFalse(try install(folder, version: "1.0.0", adopt: true).adopted)
    XCTAssertEqual(PluginPrograms.linkTarget("\(legacy)/current"), "0.2.41", "an install in progress is left alone")
    XCTAssertTrue(FileManager.default.fileExists(atPath: "\(legacy)/0.2.41"))
    close(held)
    XCTAssertTrue(try install(folder, version: "1.0.0", adopt: true).adopted)
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
