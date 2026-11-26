import CryptoKit
import XCTest

@testable import ArdiaPluginCore

final class PluginStoreTests: XCTestCase {
  var root = ""
  var store: PluginStore!
  let key = "test__tool"
  var places: ProgramPlaces!

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("store-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = PluginSandbox.resolved(made.path)!
    store = PluginStore(root: "\(root)/Plugins/store")
    places = ProgramPlaces(store: "\(root)/Programs", binDir: "\(root)/bin")
    places.shadowable = []
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  func tarHeader(_ name: String, type: UInt8, size: Int = 0, mode: Int = 0o644, link: String = "") -> [UInt8] {
    var header = [UInt8](repeating: 0, count: 512)
    func put(_ text: String, at offset: Int, _ length: Int) {
      for (index, byte) in text.utf8.prefix(length).enumerated() { header[offset + index] = byte }
    }
    put(name, at: 0, 100)
    put(String(format: "%07o", mode), at: 100, 8)
    put("0000000", at: 108, 8)
    put("0000000", at: 116, 8)
    put(String(format: "%011o", size), at: 124, 12)
    put("00000000000", at: 136, 12)
    put("        ", at: 148, 8)
    header[156] = type
    put(link, at: 157, 100)
    put("ustar", at: 257, 6)
    put("00", at: 263, 2)
    let sum = header.reduce(0) { $0 + Int($1) }
    put(String(format: "%06o", sum) + "\0 ", at: 148, 8)
    return header
  }

  func tar(_ entries: [(name: String, type: UInt8, body: Data, mode: Int, link: String)]) -> Data {
    var data = Data()
    for entry in entries {
      data.append(contentsOf: tarHeader(entry.name, type: entry.type, size: entry.body.count, mode: entry.mode, link: entry.link))
      data.append(entry.body)
      let pad = (512 - entry.body.count % 512) % 512
      data.append(Data(count: pad))
    }
    data.append(Data(count: 1024))
    return data
  }

  func gzip(_ data: Data, name: String) throws -> String {
    let raw = "\(root)/\(name).tar"
    try data.write(to: URL(fileURLWithPath: raw))
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/gzip")
    process.arguments = ["-n", "-f", raw]
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    return raw + ".gz"
  }

  func manifest(_ version: String = "1.2.0", id: String = "@test/tool") -> String {
    #"{"manifest":3,"id":"\#(id)","name":"Tool","description":"A tool.","version":"\#(version)","engines":{"ardia":">=0.0.0"},"scope":"global","contributes":{"programs":[{"name":"tool","path":"bin/tool"}]}}"#
  }

  func pluginArchive(_ manifestText: String, extra: [(name: String, type: UInt8, body: Data, mode: Int, link: String)] = [], tool: Data = Data("#!/bin/sh\necho hi\n".utf8)) throws -> String {
    let entries: [(name: String, type: UInt8, body: Data, mode: Int, link: String)] = [
      ("tool/", UInt8(ascii: "5"), Data(), 0o755, ""),
      ("tool/bin/", UInt8(ascii: "5"), Data(), 0o755, ""),
      ("tool/plugin.json", UInt8(ascii: "0"), Data(manifestText.utf8), 0o644, ""),
      ("tool/bin/tool", UInt8(ascii: "0"), tool, 0o755, ""),
    ] + extra
    return try gzip(tar(entries), name: "tool-\(UUID().uuidString)")
  }

  func entry(sha: String, version: String? = "1.2.0") -> StoreExpectation {
    StoreExpectation(key: key, id: "@test/tool", version: version, sha256: sha)
  }

  func publish(_ archive: String, entry: StoreExpectation) -> Result<PluginInstaller.Published, PluginInstaller.Failure> {
    let scratch = store.makeScratch(key, prefix: ".fetch-")!
    defer { PluginPrograms.discard(scratch) }
    let download = "\(scratch)/download.tar.gz"
    try? FileManager.default.copyItem(atPath: archive, toPath: download)
    return PluginInstaller.verifyAndPublish(entry, archive: download, scratch: scratch, store: store)
  }

  func testAVerifiedDownloadIsPublishedByVersionAndDigestAndStaysOutOfTheActiveCopyUntilActivated() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertEqual(made.copy.path, "\(root)/Plugins/store/@test/tool/1.2.0-\(sha.prefix(12))")
    XCTAssertEqual(made.copy.payloadDigest, PluginPrograms.payloadDigest(made.copy.path))
    XCTAssertNil(store.active(key), "a candidate isn't active until the user confirms")
    XCTAssertFalse(hasQuarantine("\(made.copy.path)/bin/tool"), "the copy isn't quarantined, so Gatekeeper never asks to notarize it")
    let approved = PluginFiles.approvalHash(text: made.manifest, folderId: made.copy.folderId)
    XCTAssertEqual(PluginInstaller.activate(key, folderId: made.copy.folderId, approved: "0" + approved.dropFirst(), store: store, officialKeys: []), "It changed since you approved it. Try again.")
    XCTAssertNil(store.active(key))
    XCTAssertNil(PluginInstaller.activate(key, folderId: made.copy.folderId, approved: approved, store: store, officialKeys: []))
    XCTAssertEqual(store.active(key), made.copy)
    let again = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertEqual(again.copy, made.copy, "the same download is reused, not replaced")
  }

  func testADownloadIsPutInPlaceOnKernelsThatWontRenameAReadOnlyFolder() throws {
    var moved: [String] = []
    store.moveFolder = { from, to in
      var info = stat()
      guard lstat(from, &info) == 0 else { return -1 }
      if (info.st_mode & S_IFMT) == S_IFDIR && info.st_mode & S_IWUSR == 0 {
        errno = EACCES
        return -1
      }
      moved.append(to)
      return renamex_np(from, to, UInt32(RENAME_EXCL))
    }
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertEqual(moved, ["\(root)/Plugins/store/@test/tool/1.2.0-\(sha.prefix(12))"], "macOS 15 and 26.3 refuse to rename a 0555 folder, so the copy moves before its root is sealed")
    XCTAssertTrue(PluginPrograms.isSealed(made.copy.path, keepingRootWritable: false), "the copy is read-only once it is in place")
    XCTAssertEqual(store.copy(key, sha: sha, fresh: true), made.copy)
  }

  func testAFailedMoveReportsItsCauseAndLeavesNothingBehind() throws {
    store.moveFolder = { _, _ in
      errno = EACCES
      return -1
    }
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    guard case .failure(let failure) = publish(archive, entry: entry(sha: sha)) else { return XCTFail("a refused move was published") }
    XCTAssertEqual(failure.code, "failed")
    XCTAssertEqual(failure.cause, .permission)
    XCTAssertEqual(failure.reason, "its copy couldn't be put in place (Permission denied)")
    let left = try FileManager.default.contentsOfDirectory(atPath: "\(root)/Plugins/store/@test/tool").filter { !$0.hasPrefix(".fetch-") }
    XCTAssertEqual(left, [], "no half-made copy or download stays behind")
  }

  func testTransferFailuresAreClassifiedByWhatFailed() {
    let posix = { (code: Int32) in NSError(domain: NSPOSIXErrorDomain, code: Int(code)) }
    let cases: [(Error, FailureCause)] = [
      (URLError(.timedOut), .timeout),
      (URLError(.notConnectedToInternet), .network),
      (URLError(.badServerResponse), .network),
      (URLError(.cannotCreateFile, userInfo: [NSUnderlyingErrorKey: posix(EACCES)]), .permission),
      (URLError(.cannotWriteToFile, userInfo: [NSUnderlyingErrorKey: posix(ENOSPC)]), .disk),
      (URLError(.cannotMoveFile, userInfo: [NSUnderlyingErrorKey: posix(EXDEV)]), .folder),
      (URLError(.cannotMoveFile), .io),
      (URLError(.noPermissionsToReadFile), .permission),
      (NSError(domain: NSCocoaErrorDomain, code: NSFileWriteNoPermissionError), .permission),
      (NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError), .disk),
      (NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut), .timeout),
      (NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet), .network),
      (NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotCreateFile, userInfo: [NSUnderlyingErrorKey: posix(EACCES)]), .permission),
      (NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotWriteToFile, userInfo: [NSUnderlyingErrorKey: posix(ENOSPC)]), .disk),
      (NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotMoveFile), .io),
    ]
    for (error, expected) in cases { XCTAssertEqual(FailureCause(transfer: error), expected, "\(error)") }
    XCTAssertEqual(FailureCause.urlCode(of: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)), .cancelled, "a raw delegate error is read by domain and code")
    XCTAssertNil(FailureCause.urlCode(of: NSError(domain: NSPOSIXErrorDomain, code: Int(NSURLErrorCancelled))))
  }

  func testPromotionTakesOnlyTheExactApprovalOfTheDownload() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    let other = PluginFiles.approvalHash(text: made.manifest, folderId: "store-" + String(repeating: "9", count: 64))
    XCTAssertNotNil(PluginInstaller.activate(key, folderId: made.copy.folderId, approved: other, store: store, officialKeys: []), "an approval of another copy never switches to this one")
    XCTAssertNil(PluginInstaller.activate(key, folderId: made.copy.folderId, approved: PluginFiles.approvalHash(text: made.manifest, folderId: made.copy.folderId), store: store, officialKeys: []))
  }

  func testASha256MismatchIsRefusedAndLeavesNothing() throws {
    let archive = try pluginArchive(manifest())
    let result = publish(archive, entry: entry(sha: String(repeating: "0", count: 64)))
    guard case .failure(let failure) = result else { return XCTFail("a mismatch was published") }
    XCTAssertEqual(failure.code, "verify")
    XCTAssertTrue(failure.reason.contains("doesn't match"))
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: "\(root)/Plugins/store/@test/tool").filter { !$0.hasPrefix(".fetch-") && !$0.hasPrefix(".trash-") }, [])
  }

  func testLinksEscapesAndStrayTopsAreRefused() throws {
    let link = ("tool/bin/evil", UInt8(ascii: "2"), Data(), 0o755, "/etc/passwd")
    let hard = ("tool/bin/hard", UInt8(ascii: "1"), Data(), 0o755, "tool/bin/tool")
    let escape = ("tool/../escaped", UInt8(ascii: "0"), Data("x".utf8), 0o644, "")
    let stray = ("other/file", UInt8(ascii: "0"), Data("x".utf8), 0o644, "")
    let device = ("tool/dev", UInt8(ascii: "3"), Data(), 0o644, "")
    let absolute = ("/tool/abs", UInt8(ascii: "0"), Data("x".utf8), 0o644, "")
    let twice = ("tool/plugin.json", UInt8(ascii: "0"), Data("{}".utf8), 0o644, "")
    let reservedAlias = ("tool/.AFTER-UPDATE", UInt8(ascii: "0"), Data(), 0o644, "")
    let foldedAlias = ("tool/.lea\u{017F}es/x", UInt8(ascii: "0"), Data(), 0o644, "")
    let cachesAlias = ("tool/bin/__PyCache__/x.pyc", UInt8(ascii: "0"), Data("x".utf8), 0o644, "")
    for bad in [link, hard, escape, stray, device, absolute, twice, reservedAlias, foldedAlias, cachesAlias] {
      let archive = try pluginArchive(manifest(), extra: [bad])
      let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
      guard case .failure(let failure) = publish(archive, entry: entry(sha: sha)) else { return XCTFail("\(bad.0) was accepted") }
      XCTAssertEqual(failure.code, "verify", bad.0)
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/Plugins/store/@test/escaped"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/escaped"))
  }

  func testAManifestThatIsntTheExpectedIdOrVersionIsRefused() throws {
    for (text, why) in [(manifest("9.9.9"), "version"), (manifest(id: "@other/tool"), "id"), (manifest().replacingOccurrences(of: "\"manifest\":3", with: "\"manifest\":2"), "manifest")] {
      let archive = try pluginArchive(text)
      let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
      guard case .failure(let failure) = publish(archive, entry: entry(sha: sha)) else { return XCTFail(why) }
      XCTAssertEqual(failure.code, "verify", why)
    }
    let archive = try pluginArchive(manifest("9.9.9"))
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha, version: nil)).get()
    XCTAssertEqual(made.version, "9.9.9", "a local archive takes the version its plugin.json gives")
  }

  let toolPrograms = [PluginProgram(name: "tool", path: "bin/tool")]

  func linkedOfficialCopy() throws -> (copy: StoreCopy, manifest: String, source: TrustedProgramCopy) {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    let folder = try XCTUnwrap(PluginFiles.openFolder(made.copy.path))
    defer { folder.close() }
    let approved = PluginFiles.approvalHash(text: made.manifest, folderId: made.copy.folderId)
    _ = try PluginPrograms.install(
      plugin: "tool", from: OpenedFolder(fd: folder.fd, path: folder.path, id: made.copy.folderId), approved: approved, version: "1.2.0",
      programs: toolPrograms, places: places, expectedDigest: made.copy.payloadDigest
    ).get()
    return (made.copy, made.manifest, TrustedProgramCopy(version: "1.2.0", approved: approved, digest: made.copy.payloadDigest))
  }

  func testACurrentThatIsntALinkIsTakenOffPATH() throws {
    let linked = try linkedOfficialCopy()
    let version = try XCTUnwrap(PluginPrograms.linkTarget("\(places.store)/tool/current"))
    XCTAssertEqual(unlink("\(places.store)/tool/current"), 0)
    try FileManager.default.copyItem(atPath: "\(places.store)/tool/\(version)", toPath: "\(places.store)/tool/current")
    try tamper("\(places.store)/tool/current/bin/tool", "#!/bin/sh\necho planted\n")
    XCTAssertEqual(PluginPrograms.dropCurrentUnlessTrusted(plugin: "tool", programs: toolPrograms, places: places, trusted: [linked.source]), .dropped)
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(places.binDir)/tool"), "nothing on PATH resolves through a planted current")
  }

  func testDroppingWorksWhenTheBinFolderCantBeListedAndOwnsUpWhenNothingCanBeSevered() throws {
    let linked = try linkedOfficialCopy()
    let version = try XCTUnwrap(PluginPrograms.linkTarget("\(places.store)/tool/current"))
    try tamper("\(places.store)/tool/\(version)/bin/tool", "#!/bin/sh\necho swapped\n")
    XCTAssertEqual(chmod(places.binDir, 0o300), 0)
    XCTAssertEqual(PluginPrograms.dropCurrentUnlessTrusted(plugin: "tool", programs: toolPrograms, places: places, trusted: [linked.source]), .dropped)
    XCTAssertEqual(chmod(places.binDir, 0o755), 0)
    XCTAssertNil(PluginPrograms.linkTarget("\(places.binDir)/tool"), "a known program is unlinked by name even when the folder can't be listed")

    let again = try linkedOfficialCopy()
    let current = try XCTUnwrap(PluginPrograms.linkTarget("\(places.store)/tool/current"))
    try tamper("\(places.store)/tool/\(current)/bin/tool", "#!/bin/sh\necho swapped\n")
    XCTAssertEqual(chmod(places.binDir, 0o555), 0)
    XCTAssertEqual(chmod("\(places.store)/tool", 0o555), 0)
    XCTAssertEqual(PluginPrograms.dropCurrentUnlessTrusted(plugin: "tool", programs: toolPrograms, places: places, trusted: [again.source]), .stuck, "a damaged copy that stays reachable is reported, not called dropped")
    XCTAssertEqual(chmod("\(places.store)/tool", 0o755), 0)
    XCTAssertEqual(chmod(places.binDir, 0o755), 0)
  }

  func hasQuarantine(_ path: String) -> Bool {
    getxattr(path, PluginStore.quarantineName, nil, 0, 0, XATTR_NOFOLLOW) >= 0
  }

  func tamper(_ path: String, _ text: String) throws {
    XCTAssertEqual(chmod((path as NSString).deletingLastPathComponent, 0o755), 0)
    chmod(path, 0o755)
    try text.write(toFile: path, atomically: false, encoding: .utf8)
  }

  func adHocTrue() throws -> Data {
    let path = "\(root)/adhoc-true"
    try FileManager.default.copyItem(atPath: "/usr/bin/true", toPath: path)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    process.arguments = ["--force", "--sign", "-", path]
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    return try Data(contentsOf: URL(fileURLWithPath: path))
  }

  func testAnAdHocProgramFromThePinnedDownloadLinksAndRuns() throws {
    let archive = try pluginArchive(manifest(), tool: adHocTrue())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    let folder = try XCTUnwrap(PluginFiles.openFolder(made.copy.path))
    defer { folder.close() }
    let approved = PluginFiles.approvalHash(text: made.manifest, folderId: folder.id)
    let linked = try PluginPrograms.install(
      plugin: "tool", from: folder, approved: approved, version: "1.2.0", programs: [PluginProgram(name: "tool", path: "bin/tool")], places: places, expectedDigest: made.copy.payloadDigest
    ).get()
    XCTAssertEqual(linked.linked, ["tool"])
    let run = Process()
    run.executableURL = URL(fileURLWithPath: "\(places.binDir)/tool")
    try run.run()
    run.waitUntilExit()
    XCTAssertEqual(run.terminationStatus, 0, "trust comes from the pinned SHA-256, not a team signature")
    XCTAssertFalse(hasQuarantine("\(places.store)/tool/current/bin/tool"))
  }

  func testAQuarantinedDownloadIsClearedOnlyAfterItsDigestMatches() throws {
    let archive = try pluginArchive(manifest())
    XCTAssertEqual(setxattr(archive, PluginStore.quarantineName, "0081;0;Test;", 12, 0, XATTR_NOFOLLOW), 0)
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    guard case .failure = publish(archive, entry: entry(sha: String(repeating: "1", count: 64))) else { return XCTFail("a mismatch was published") }
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertFalse(hasQuarantine("\(made.copy.path)/bin/tool"))
    XCTAssertFalse(hasQuarantine("\(made.copy.path)/plugin.json"))
  }

  func testLinkingRefusesAProgramCopyThatIsntTheVerifiedDownload() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    let folder = try XCTUnwrap(PluginFiles.openFolder(made.copy.path))
    defer { folder.close() }
    let approved = PluginFiles.approvalHash(text: made.manifest, folderId: folder.id)
    try tamper("\(made.copy.path)/bin/tool", "#!/bin/sh\necho swapped\n")
    guard case .failure(let refusal) = PluginPrograms.install(
      plugin: "tool", from: folder, approved: approved, version: "1.2.0", programs: [PluginProgram(name: "tool", path: "bin/tool")], places: places, expectedDigest: made.copy.payloadDigest)
    else { return XCTFail("linked a copy that isn't the verified download") }
    XCTAssertTrue(refusal.reason.contains("don't match"))
    XCTAssertNil(PluginPrograms.linkTarget("\(places.binDir)/tool"))
  }

  func makeFolder(_ version: String, say: String) throws -> OpenedFolder {
    let folder = "\(root)/src-\(version)"
    try FileManager.default.createDirectory(atPath: "\(folder)/bin", withIntermediateDirectories: true)
    try manifest(version).write(toFile: "\(folder)/plugin.json", atomically: true, encoding: .utf8)
    try "#!/bin/sh\necho \(say)\n".write(toFile: "\(folder)/bin/tool", atomically: true, encoding: .utf8)
    XCTAssertEqual(chmod("\(folder)/bin/tool", 0o755), 0)
    return try XCTUnwrap(PluginFiles.openFolder(folder))
  }

  func install(_ given: OpenedFolder, version: String, identity: String? = nil) throws -> ProgramsLinked {
    let folder = identity.map { OpenedFolder(fd: given.fd, path: given.path, id: $0) } ?? given
    guard case .text(let text) = PluginFiles.readManifest(in: folder) else { throw XCTSkip("no manifest") }
    return try PluginPrograms.install(
      plugin: "tool", from: folder, approved: PluginFiles.approvalHash(text: text, folderId: folder.id), version: version, programs: [PluginProgram(name: "tool", path: "bin/tool")],
      places: places
    ).get()
  }

  func testAReplacementThatCantTakeOverPATHLeavesTheOldTargetInPlaceAndARetryFinishesIt() throws {
    let old = try makeFolder("1.0.0", say: "old")
    defer { old.close() }
    let first = try install(old, version: "1.0.0")
    XCTAssertEqual(first.linked, ["tool"])
    let before = PluginPrograms.linkTarget("\(places.store)/tool/current")
    unlink("\(places.binDir)/tool")
    try "someone else's".write(toFile: "\(places.binDir)/tool", atomically: true, encoding: .utf8)
    let new = try makeFolder("2.0.0", say: "new")
    defer { new.close() }
    let held = try install(new, version: "2.0.0")
    XCTAssertEqual(held.linked, [])
    XCTAssertNotNil(held.refused["tool"])
    XCTAssertEqual(held.kept, before)
    XCTAssertEqual(PluginPrograms.linkTarget("\(places.store)/tool/current"), before, "current isn't switched while PATH refuses the new one")
    try FileManager.default.removeItem(atPath: "\(places.binDir)/tool")
    let retried = try install(new, version: "2.0.0")
    XCTAssertEqual(retried.linked, ["tool"])
    XCTAssertNotEqual(PluginPrograms.linkTarget("\(places.store)/tool/current"), before)
  }

  func testRemovingWhileAnAfterUpdateCommandRunsTakesItOffPATHAndLeavesTheLeasedCopyUntilItEnds() throws {
    let old = try makeFolder("1.0.0", say: "old")
    defer { old.close() }
    let linked = try install(old, version: "1.0.0")
    let lease = try XCTUnwrap(PluginPrograms.lease(plugin: "tool", version: linked.version, places: places))
    XCTAssertFalse(PluginPrograms.remove(plugin: "tool", programs: ["tool"], places: places), "a running command keeps its copy")
    XCTAssertNil(PluginPrograms.linkTarget("\(places.binDir)/tool"))
    XCTAssertNil(PluginPrograms.linkTarget("\(places.store)/tool/current"))
    XCTAssertTrue(FileManager.default.fileExists(atPath: "\(places.store)/tool/\(linked.version)"))
    unlink(lease)
    XCTAssertTrue(PluginPrograms.remove(plugin: "tool", programs: ["tool"], places: places))
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(places.store)/tool"))
  }

  func testAnInterruptedPublishLeavesNoHalfCopyAndTheNextOneFinishes() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    try FileManager.default.createDirectory(atPath: "\(root)/Plugins/store/@test/tool/1.2.0-\(sha.prefix(12))", withIntermediateDirectories: true)
    XCTAssertNil(store.copy(key, sha: sha), "a folder without its download is a crash between files, not a copy")
    let orphan = String(repeating: "c", count: 64)
    try Data("x".utf8).write(to: URL(fileURLWithPath: "\(root)/Plugins/store/@test/tool/9.9.9-\(orphan.prefix(12)).tar.gz"))
    store.sweep(key)
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/Plugins/store/@test/tool/9.9.9-\(orphan.prefix(12)).tar.gz"), "a download whose folder never arrived is dropped")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/Plugins/store/@test/tool/1.2.0-\(sha.prefix(12))"), "a folder with no download is dropped")
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertEqual(store.copy(key, sha: sha), made.copy)
    XCTAssertTrue(FileManager.default.fileExists(atPath: "\(made.copy.path)/plugin.json"))
    XCTAssertTrue(store.activate(key, sha: sha))
    XCTAssertTrue(store.remove(key))
    XCTAssertNil(store.active(key))
  }

  func testACopyThatNoLongerMatchesItsDownloadIsNotTrusted() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    try tamper("\(made.copy.path)/bin/tool", "#!/bin/sh\necho swapped\n")
    let approved = PluginFiles.approvalHash(text: made.manifest, folderId: made.copy.folderId)
    XCTAssertNil(store.copy(key, sha: sha), "an edit inside a copy already checked this launch is still noticed")
    XCTAssertNotNil(PluginInstaller.activate(key, folderId: made.copy.folderId, approved: approved, store: store, officialKeys: []), "activation re-verifies against the download")
    let other = try pluginArchive(manifest("1.2.0"), tool: Data("#!/bin/sh\necho other\n".utf8))
    try FileManager.default.removeItem(atPath: "\(made.copy.path).tar.gz")
    try FileManager.default.copyItem(atPath: other, toPath: "\(made.copy.path).tar.gz")
    StoreVerification.shared.forgetAll()
    XCTAssertNil(store.copy(key, sha: sha), "a download that isn't the pinned SHA-256 vouches for nothing")
  }

  func testAFailedSwitchKeepsACopyOnlyWhileItMatchesTheCheckedCopyItCameFrom() throws {
    let first = try pluginArchive(manifest())
    let firstSha = try XCTUnwrap(PluginArchive.sha256(file: first))
    let earlier = try publish(first, entry: entry(sha: firstSha)).get()
    let second = try pluginArchive(manifest(), tool: Data("#!/bin/sh\necho second\n".utf8))
    let secondSha = try XCTUnwrap(PluginArchive.sha256(file: second))
    let later = try publish(second, entry: entry(sha: secondSha)).get()
    let source = { (made: PluginInstaller.Published) in
      TrustedProgramCopy(version: "1.2.0", approved: PluginFiles.approvalHash(text: made.manifest, folderId: made.copy.folderId), digest: made.copy.payloadDigest)
    }
    let folder = try XCTUnwrap(PluginFiles.openFolder(earlier.copy.path))
    defer { folder.close() }
    _ = try PluginPrograms.install(
      plugin: "tool", from: OpenedFolder(fd: folder.fd, path: folder.path, id: earlier.copy.folderId), approved: source(earlier).approved, version: "1.2.0",
      programs: [PluginProgram(name: "tool", path: "bin/tool")], places: places, expectedDigest: earlier.copy.payloadDigest
    ).get()
    XCTAssertEqual(PluginPrograms.dropCurrentUnlessTrusted(plugin: "tool", programs: toolPrograms, places: places, trusted: [source(earlier), source(later)]), .trusted)
    XCTAssertNotNil(PluginPrograms.linkTarget("\(places.binDir)/tool"))

    let version = try XCTUnwrap(PluginPrograms.linkTarget("\(places.store)/tool/current"))
    try tamper("\(places.store)/tool/\(version)/bin/tool", "#!/bin/sh\necho swapped\n")
    XCTAssertEqual(PluginPrograms.dropCurrentUnlessTrusted(plugin: "tool", programs: toolPrograms, places: places, trusted: [source(earlier), source(later)]), .dropped, "the earlier copy is held to its own checked digest, not the new one's")
    XCTAssertNil(PluginPrograms.linkTarget("\(places.binDir)/tool"))
    XCTAssertNil(PluginPrograms.linkTarget("\(places.store)/tool/current"))
  }

  func testAFailedSwitchDropsAnEarlierCopyWithNoCheckedSource() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    let folder = try XCTUnwrap(PluginFiles.openFolder(made.copy.path))
    defer { folder.close() }
    _ = try PluginPrograms.install(
      plugin: "tool", from: OpenedFolder(fd: folder.fd, path: folder.path, id: made.copy.folderId),
      approved: PluginFiles.approvalHash(text: made.manifest, folderId: made.copy.folderId), version: "1.2.0",
      programs: [PluginProgram(name: "tool", path: "bin/tool")], places: places, expectedDigest: made.copy.payloadDigest
    ).get()
    XCTAssertEqual(PluginPrograms.dropCurrentUnlessTrusted(plugin: "tool", programs: toolPrograms, places: places, trusted: []), .dropped, "a copy whose download is gone can't be vouched for")
    XCTAssertNil(PluginPrograms.linkTarget("\(places.binDir)/tool"))
  }

  func testNamesOutsideTheDigestAreRefusedAndPlantedOnesBreakTheMatch() throws {
    for bad in [("tool/__pycache__/x.pyc", UInt8(ascii: "0"), Data("x".utf8), 0o644, ""), ("tool/.leases/1", UInt8(ascii: "0"), Data(), 0o644, "")] {
      let archive = try pluginArchive(manifest(), extra: [bad])
      let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
      guard case .failure(let failure) = publish(archive, entry: entry(sha: sha)) else { return XCTFail("\(bad.0) was accepted") }
      XCTAssertEqual(failure.code, "verify")
    }
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertEqual(chmod("\(made.copy.path)/bin", 0o755), 0)
    try FileManager.default.createDirectory(atPath: "\(made.copy.path)/bin/__pycache__", withIntermediateDirectories: true)
    try "x".write(toFile: "\(made.copy.path)/bin/__pycache__/planted.pyc", atomically: true, encoding: .utf8)
    XCTAssertNil(store.copy(key, sha: sha), "a planted cache file isn't skipped by an official copy's digest")
  }

  func testADamagedActiveCopyCanBeRepaired() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertTrue(store.activate(key, sha: sha))
    XCTAssertNil(PluginInstaller.activate(key, folderId: made.copy.folderId, approved: PluginFiles.approvalHash(text: made.manifest, folderId: made.copy.folderId), store: store, officialKeys: []), "its own exact approval holds")
    try tamper("\(made.copy.path)/bin/tool", "#!/bin/sh\necho damaged\n")
    XCTAssertNil(store.active(key))
    let repaired = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertEqual(store.active(key), repaired.copy, "a clean download of the same pinned file replaces a damaged active copy")
  }

  func testAFailedFreshCheckClearsTheRecentCheck() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertNotNil(store.copy(key, sha: sha))
    try tamper("\(made.copy.path)/bin/tool", "#!/bin/sh\necho swapped\n")
    XCTAssertNil(store.copy(key, sha: sha, fresh: true))
    XCTAssertNil(store.copy(key, sha: sha), "a mismatch found by a fresh check isn't hidden by the recent good one")
  }

  func testAPublishedCopyIsReadOnlyInAPrivateFolder() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    var info = stat()
    XCTAssertEqual(lstat(made.copy.path, &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o555)
    XCTAssertEqual(lstat("\(made.copy.path)/bin/tool", &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o555)
    XCTAssertEqual(lstat("\(made.copy.path)/plugin.json", &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o444)
    XCTAssertEqual(lstat(store.archivePath(key, sha)!, &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o444)
    let scratch = try XCTUnwrap(store.makeScratch(key, prefix: ".stage-"))
    XCTAssertEqual(lstat(scratch, &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o700, "unpacking happens in a folder only Ardia's user can enter")
    XCTAssertTrue(store.remove(key), "removal unseals what it deletes")
  }

  func testACopyMadeWritableAgainIsNoLongerTrusted() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    let folder = try XCTUnwrap(PluginFiles.openFolder(made.copy.path))
    defer { folder.close() }
    let approved = PluginFiles.approvalHash(text: made.manifest, folderId: folder.id)
    let programs = [PluginProgram(name: "tool", path: "bin/tool")]
    _ = try PluginPrograms.install(plugin: "tool", from: folder, approved: approved, version: "1.2.0", programs: programs, places: places, expectedDigest: made.copy.payloadDigest).get()
    let trusted = [TrustedProgramCopy(version: "1.2.0", approved: approved, digest: made.copy.payloadDigest)]
    let version = try XCTUnwrap(PluginPrograms.linkTarget("\(places.store)/tool/current"))
    XCTAssertTrue(PluginPrograms.currentIsTrusted(version, plugin: "tool", programs: toolPrograms, places: places, trusted: trusted))
    let staged = "\(places.store)/tool/\(version)"
    XCTAssertTrue(PluginPrograms.holdsApproved(staged, folderId: folder.id, approved: approved, programs: programs, expectedDigest: made.copy.payloadDigest))
    XCTAssertEqual(chmod("\(staged)/bin", 0o755), 0)
    XCTAssertEqual(chmod("\(staged)/bin/tool", 0o755), 0)
    XCTAssertFalse(PluginPrograms.holdsApproved(staged, folderId: folder.id, approved: approved, programs: programs, expectedDigest: made.copy.payloadDigest), "a program copy that can be written is not reused, even with the same bytes")
    XCTAssertEqual(PluginPrograms.dropCurrentUnlessTrusted(plugin: "tool", programs: toolPrograms, places: places, trusted: trusted), .dropped)
    XCTAssertEqual(chmod("\(made.copy.path)/bin", 0o755), 0)
    StoreVerification.shared.forgetAll()
    XCTAssertNil(store.copy(key, sha: sha), "a published copy that can be written is not official")
  }

  func testNothingIsUnpackedUnderAFolderOtherUsersCanRename() throws {
    let shared = "\(root)/shared"
    XCTAssertEqual(mkdir(shared, 0o755), 0)
    XCTAssertEqual(chmod(shared, 0o777), 0)
    let exposed = PluginStore(root: "\(shared)/Plugins/store")
    XCTAssertNil(exposed.makeScratch(key, prefix: ".stage-"), "another user could swap the folder out before it is unpacked into")
    XCTAssertEqual(chmod(shared, 0o1777), 0)
    XCTAssertNotNil(exposed.makeScratch(key, prefix: ".stage-"), "a sticky folder like /tmp keeps its entries to their owners")
    XCTAssertEqual(chmod(shared, 0o755), 0)
    let acl = Process()
    acl.executableURL = URL(fileURLWithPath: "/bin/chmod")
    acl.arguments = ["+a", "everyone allow add_file,add_subdirectory,delete_child", shared]
    try acl.run()
    acl.waitUntilExit()
    XCTAssertEqual(acl.terminationStatus, 0)
    XCTAssertNil(exposed.makeScratch(key, prefix: ".stage-"), "an ACL can hand others the folder even though its mode says 0755")
    let denyOnly = Process()
    denyOnly.executableURL = URL(fileURLWithPath: "/bin/chmod")
    denyOnly.arguments = ["-N", shared]
    try denyOnly.run()
    denyOnly.waitUntilExit()
    XCTAssertNotNil(exposed.makeScratch(key, prefix: ".stage-"))
  }

  func testAStoreReachedThroughASymlinkIsntUnpackedInto() throws {
    let real = "\(root)/elsewhere"
    XCTAssertEqual(mkdir(real, 0o700), 0)
    XCTAssertEqual(symlink(real, "\(root)/Linked"), 0)
    let linked = PluginStore(root: "\(root)/Linked")
    XCTAssertNil(linked.makeScratch(key, prefix: ".stage-"), "the folder checked and the folder unpacked into could differ")
  }

  func testProgramsUnderAFolderOtherUsersCanChangeArentInstalled() throws {
    let shared = "\(root)/shared-programs"
    XCTAssertEqual(mkdir(shared, 0o755), 0)
    XCTAssertEqual(chmod(shared, 0o777), 0)
    let exposed = ProgramPlaces(store: "\(shared)/Programs", binDir: "\(root)/bin")
    let folder = try makeFolder("1.0.0", say: "hi")
    defer { folder.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: folder) else { return XCTFail("no manifest") }
    guard case .failure(let refusal) = PluginPrograms.install(
      plugin: "tool", from: folder, approved: PluginFiles.approvalHash(text: text, folderId: folder.id), version: "1.0.0", programs: toolPrograms, places: exposed)
    else { return XCTFail("installed where another user could swap the copy") }
    XCTAssertTrue(refusal.reason.contains("other users"))
    XCTAssertNil(PluginPrograms.linkTarget("\(root)/bin/tool"))
    XCTAssertEqual(chmod(shared, 0o755), 0)
  }

  func testPATHFoldersOtherUsersCanSwapGetNoLinksButASymlinkedParentIsFine() throws {
    let shared = "\(root)/shared-home"
    XCTAssertEqual(mkdir(shared, 0o755), 0)
    XCTAssertEqual(chmod(shared, 0o777), 0)
    let exposed = ProgramPlaces(store: "\(root)/Programs", binDir: "\(shared)/bin")
    let folder = try makeFolder("1.0.0", say: "hi")
    defer { folder.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: folder) else { return XCTFail("no manifest") }
    let approved = PluginFiles.approvalHash(text: text, folderId: folder.id)
    let held = try PluginPrograms.install(plugin: "tool", from: folder, approved: approved, version: "1.0.0", programs: toolPrograms, places: exposed).get()
    XCTAssertEqual(held.linked, [])
    XCTAssertTrue(held.refused["tool"]?.contains("other users") == true)
    XCTAssertEqual(chmod(shared, 0o755), 0)

    let dotfiles = "\(root)/dotfiles-local"
    XCTAssertEqual(mkdir(dotfiles, 0o755), 0)
    XCTAssertEqual(symlink(dotfiles, "\(root)/linked-local"), 0)
    let linked = ProgramPlaces(store: "\(root)/Programs", binDir: "\(root)/linked-local/bin")
    XCTAssertEqual(try PluginPrograms.install(plugin: "tool", from: folder, approved: approved, version: "1.0.0", programs: toolPrograms, places: linked).get().linked, ["tool"], "a bin folder reached through a symlinked parent, like a dotfiles ~/.local, still works")
  }

  func testCleanupForAnOlderVersionLeavesANewerLinkAlone() throws {
    let linked = try linkedOfficialCopy()
    let version = try XCTUnwrap(PluginPrograms.linkTarget("\(places.store)/tool/current"))
    XCTAssertEqual(PluginPrograms.dropCurrentUnlessTrusted(plugin: "tool", programs: toolPrograms, places: places, trusted: [], onlyVersion: "0.0.1-aaaaaaaaaaaa"), .trusted)
    XCTAssertEqual(PluginPrograms.linkTarget("\(places.store)/tool/current"), version, "a check that failed on another version doesn't drop this one")
    XCTAssertNotNil(PluginPrograms.linkTarget("\(places.binDir)/tool"))
    _ = linked
  }

  func testAQuarantineFlagStaysOnADownloadThatDoesntMatch() throws {
    let archive = try pluginArchive(manifest())
    XCTAssertEqual(setxattr(archive, PluginStore.quarantineName, "0081;0;Test;", 12, 0, XATTR_NOFOLLOW), 0)
    let scratch = try XCTUnwrap(store.makeScratch(key, prefix: ".fetch-"))
    let result = PluginInstaller.verifyAndPublish(entry(sha: String(repeating: "1", count: 64)), archive: archive, scratch: scratch, store: store)
    guard case .failure(let failure) = result else { return XCTFail("a mismatch was published") }
    XCTAssertEqual(failure.code, "verify")
    XCTAssertTrue(hasQuarantine(archive), "nothing is cleared before the SHA-256 matches")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: scratch), [], "nothing was unpacked")
  }

  func testAQuarantinedArchiveIsClearedToo() throws {
    let archive = try pluginArchive(manifest())
    XCTAssertEqual(setxattr(archive, PluginStore.quarantineName, "0081;0;Test;", 12, 0, XATTR_NOFOLLOW), 0)
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    _ = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertFalse(hasQuarantine(store.archivePath(key, sha)!))
  }

  func testAnArchivePackedLikeBuildShUnpacks() throws {
    let work = "\(root)/pack"
    let deep = "tool/" + Array(repeating: "a-rather-long-folder-name", count: 6).joined(separator: "/")
    try FileManager.default.createDirectory(atPath: "\(work)/\(deep)", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: "\(work)/tool/bin", withIntermediateDirectories: true)
    try manifest().write(toFile: "\(work)/tool/plugin.json", atomically: true, encoding: .utf8)
    try "#!/bin/sh\n".write(toFile: "\(work)/tool/bin/tool", atomically: true, encoding: .utf8)
    try "deep".write(toFile: "\(work)/\(deep)/file-with-a-long-name-too.txt", atomically: true, encoding: .utf8)
    XCTAssertEqual(chmod("\(work)/tool/bin/tool", 0o755), 0)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
    process.currentDirectoryURL = URL(fileURLWithPath: work)
    process.environment = ["COPYFILE_DISABLE": "1"]
    process.arguments = ["--no-mac-metadata", "-czf", "\(root)/packed.tar.gz", "tool"]
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    let sha = try XCTUnwrap(PluginArchive.sha256(file: "\(root)/packed.tar.gz"))
    let made = try publish("\(root)/packed.tar.gz", entry: entry(sha: sha)).get()
    XCTAssertEqual(try String(contentsOfFile: "\(made.copy.path)/\(String(deep.dropFirst(5)))/file-with-a-long-name-too.txt", encoding: .utf8), "deep")
    XCTAssertTrue(FileManager.default.isExecutableFile(atPath: "\(made.copy.path)/bin/tool"))
  }

  func unpack(_ archive: String, into stage: String, limits: PluginArchive.Limits = .standard) -> String? {
    guard let held = PluginArchive.snapshot(archive, in: root, limits: limits) else { return "no snapshot" }
    defer { held.close() }
    let folder = open(stage, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard folder >= 0 else { return "no stage" }
    defer { close(folder) }
    return PluginArchive.unpack(held.fd, top: "tool", into: folder, scratch: root, limits: limits)
  }

  func freshStage() throws -> String {
    let stage = "\(root)/stage-\(UUID().uuidString)"
    XCTAssertEqual(mkdir(stage, 0o700), 0)
    return stage
  }

  func file(_ name: String, _ body: Data) -> (name: String, type: UInt8, body: Data, mode: Int, link: String) {
    (name, UInt8(ascii: "0"), body, 0o644, "")
  }

  func noise(_ count: Int) -> Data {
    var data = Data(count: count)
    data.withUnsafeMutableBytes { arc4random_buf($0.baseAddress, count) }
    return data
  }

  func testTheStandardCapsAreTheDocumentedOnes() {
    let limits = PluginArchive.Limits.standard
    XCTAssertEqual(limits.download, 512 << 20)
    XCTAssertEqual(limits.expanded, 1 << 30)
    XCTAssertEqual(limits.entries, 20_000)
    XCTAssertEqual(limits.depth, 32)
    XCTAssertEqual(limits.ratio, 100)
    XCTAssertEqual(limits.entryRatio, 200)
    XCTAssertEqual(limits.ratioFloor, 4 << 20)
    XCTAssertEqual(limits.expandedAllowed(compressed: 1_000), 4 << 20, "a small download may still unpack to the floor")
    XCTAssertEqual(limits.expandedAllowed(compressed: 100 << 20), 1 << 30, "never past the expanded cap")
    XCTAssertEqual(limits.expandedAllowed(compressed: .max), 1 << 30)
  }

  func testADownloadOverTheSizeCapIsNotTaken() throws {
    let archive = try pluginArchive(manifest(), extra: [file("tool/noise", noise(64 << 10))])
    var small = PluginArchive.Limits.standard
    small.download = 32 << 10
    XCTAssertNil(PluginArchive.snapshot(archive, in: root, limits: small))
    XCTAssertEqual(unpack(archive, into: try freshStage(), limits: small), "no snapshot")
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    XCTAssertNil(PluginArchive.verifiedPayloadDigest(archive: archive, sha: sha, top: "tool", scratch: root, limits: small))
    XCTAssertNotNil(PluginArchive.verifiedPayloadDigest(archive: archive, sha: sha, top: "tool", scratch: root))
  }

  func testMoreEntriesThanTheCapAreRefused() throws {
    var small = PluginArchive.Limits.standard
    small.entries = 40
    let folders = (0..<40).map { (name: "tool/d\($0)/", type: UInt8(ascii: "5"), body: Data(), mode: 0o755, link: "") }
    let archive = try pluginArchive(manifest(), extra: folders)
    XCTAssertEqual(unpack(archive, into: try freshStage(), limits: small), "the archive has more than 40 entries")
    let fits = try pluginArchive(manifest(), extra: Array(folders.prefix(36)))
    XCTAssertNil(unpack(fits, into: try freshStage(), limits: small), "exactly the cap unpacks")
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    XCTAssertNil(PluginArchive.verifiedPayloadDigest(archive: archive, sha: sha, top: "tool", scratch: root, limits: small), "verifying a kept copy holds to the same cap")
  }

  func testFoldersAFileImpliesCountTowardTheEntryCap() throws {
    var small = PluginArchive.Limits.standard
    small.entries = 40
    let deep = (0..<5).map { file("tool/\($0)/a/b/c/d/e/f/g/h/i", Data("x".utf8)) }
    let archive = try pluginArchive(manifest(), extra: deep)
    let stage = try freshStage()
    XCTAssertEqual(unpack(archive, into: stage, limits: small), "the archive has more than 40 entries", "9 headers, but 45 folders made")
    XCTAssertNil(unpack(try pluginArchive(manifest(), extra: Array(deep.prefix(3))), into: try freshStage(), limits: small), "3 such files, 30 folders, fit")
  }

  func testAFileUnderAnExistingFolderCanStillCrossTheEntryCap() throws {
    var small = PluginArchive.Limits.standard
    small.entries = 40
    let deep = file("tool/" + Array(repeating: "a", count: 30).joined(separator: "/") + "/f", Data("x".utf8))
    let more = (0..<10).map { file("tool/bin/extra\($0)", Data("x".utf8)) }
    let archive = try pluginArchive(manifest(), extra: [deep] + more)
    XCTAssertEqual(unpack(archive, into: try freshStage(), limits: small), "the archive has more than 40 entries", "15 headers, but the files in bin take the paths past 40")
    XCTAssertNil(unpack(try pluginArchive(manifest(), extra: [deep] + Array(more.prefix(4))), into: try freshStage(), limits: small))
  }

  func testTrailingBytesAfterTheGzipMemberAreRefused() throws {
    let archive = try pluginArchive(manifest(), extra: [file("tool/zeros", Data(count: 3 << 20))])
    let padded = "\(root)/padded.tar.gz"
    var bytes = try Data(contentsOf: URL(fileURLWithPath: archive))
    bytes.append(noise(4 << 20))
    try bytes.write(to: URL(fileURLWithPath: padded))
    XCTAssertEqual(unpack(padded, into: try freshStage()), "the download has data after its archive")
    let twice = "\(root)/twice.tar.gz"
    let original = try Data(contentsOf: URL(fileURLWithPath: archive))
    try (original + original).write(to: URL(fileURLWithPath: twice))
    XCTAssertEqual(unpack(twice, into: try freshStage()), "the download has data after its archive", "a second gzip member is refused too")
    var corrupt = original
    corrupt[corrupt.count - 6] ^= 0xff
    let badCheck = "\(root)/bad-crc.tar.gz"
    try corrupt.write(to: URL(fileURLWithPath: badCheck))
    XCTAssertEqual(unpack(badCheck, into: try freshStage()), "the download is damaged", "the trailer's CRC is checked")
  }

  func testAnOutOfRangePaxRecordLengthIsRefusedNotTrapped() {
    XCTAssertNil(PluginArchive.paxPath(Data("9223372036854775807 path=x\n".utf8)))
  }

  func testFoldersDeeperThanTheCapAreRefused() throws {
    let deepest = Array(repeating: "a", count: PluginArchive.maxDepth - 1).joined(separator: "/")
    let fits = try pluginArchive(manifest(), extra: [file("tool/\(deepest)", Data("deep".utf8))])
    XCTAssertNil(unpack(fits, into: try freshStage()), "a file \(PluginArchive.maxDepth) parts deep unpacks")
    let archive = try pluginArchive(manifest(), extra: [file("tool/\(deepest)/b", Data("deep".utf8))])
    XCTAssertEqual(unpack(archive, into: try freshStage()), "tool/\(deepest)/b isn't inside tool/ or is more than 32 folders deep")
  }

  func testUnpackingPastTheExpandedCapStops() throws {
    let archive = try pluginArchive(manifest(), extra: [file("tool/noise", noise(2 << 20))])
    var small = PluginArchive.Limits.standard
    small.expanded = 1 << 20
    XCTAssertEqual(unpack(archive, into: try freshStage(), limits: small), "the download unpacks to more than 1 MB")
    XCTAssertNil(unpack(archive, into: try freshStage()))
  }

  func testADownloadThatInflatesPastTheRatioIsRefused() throws {
    let archive = try pluginArchive(manifest(), extra: [file("tool/zeros", Data(count: 16 << 20))])
    let stage = try freshStage()
    XCTAssertEqual(unpack(archive, into: stage), "the download unpacks to more than 100 times its size")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(stage)/zeros"), "it stops before the tar is read")
  }

  func testOneEntryThatInflatesPastItsRatioIsRefusedAmongOrdinaryOnes() throws {
    let archive = try pluginArchive(manifest(), extra: [file("tool/noise", noise(8 << 20)), file("tool/zeros", Data(count: 6 << 20))])
    let stage = try freshStage()
    XCTAssertEqual(unpack(archive, into: stage), "tool/zeros unpacks to more than 200 times its compressed size")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(stage)/zeros"), "it is refused before a byte of it is written")
    let ordinary = try pluginArchive(manifest(), extra: [file("tool/noise", noise(8 << 20)), file("tool/text", Data(String(repeating: "a", count: 3 << 20).utf8))])
    XCTAssertNil(unpack(ordinary, into: try freshStage()), "a highly compressible file under the floor is fine")
  }

  func testInflationEstimatesNeverUndercountWhatAnEntryTook() {
    var inflation = PluginArchive.Inflation()
    inflation.mark(produced: 1 << 20, consumed: 1_000)
    inflation.mark(produced: 2 << 20, consumed: 900_000)
    inflation.mark(produced: 3 << 20, consumed: 901_000)
    XCTAssertEqual(inflation.compressed(from: 0, to: 1 << 20), 1_000)
    XCTAssertEqual(inflation.compressed(from: 512, to: (1 << 20) + 1), 900_000, "a range that crosses a mark counts the whole step it ends in")
    XCTAssertEqual(inflation.compressed(from: 2 << 20, to: 3 << 20), 1_000)
    XCTAssertEqual(inflation.compressed(from: 3 << 20, to: 3 << 20), 1, "never zero")
  }

  func testTheBytesHashedAreTheBytesUnpackedEvenIfTheDownloadChangesAfterward() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let held = try XCTUnwrap(PluginArchive.snapshot(archive, in: root))
    defer { held.close() }
    XCTAssertEqual(held.sha, sha)
    var info = stat()
    XCTAssertEqual(fstat(held.fd, &info), 0)
    XCTAssertEqual(info.st_nlink, 0, "the snapshot has no path, so nothing can open it again")
    let other = try pluginArchive(manifest(), tool: Data("#!/bin/sh\necho other\n".utf8))
    try FileManager.default.removeItem(atPath: archive)
    try FileManager.default.copyItem(atPath: other, toPath: archive)
    let stage = try XCTUnwrap(store.makeScratch(key, prefix: ".stage-"))
    let folder = open(stage, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    defer { close(folder) }
    XCTAssertNil(PluginArchive.unpack(held.fd, top: "tool", into: folder, scratch: root))
    XCTAssertEqual(try String(contentsOfFile: "\(stage)/bin/tool", encoding: .utf8), "#!/bin/sh\necho hi\n", "what is unpacked is what was hashed, not what the path holds now")
    let made = try store.publish(key, version: "1.2.0", staged: stage, archive: held, sha: sha).get()
    XCTAssertEqual(PluginArchive.sha256(file: store.archivePath(key, sha)!), sha, "the kept download is written from the verified bytes")
    XCTAssertEqual(made.sha, sha)
  }

  func testUnpackingOpensEveryFolderWithoutFollowingALink() throws {
    let stage = "\(root)/stage-links"
    let outside = "\(root)/outside"
    try FileManager.default.createDirectory(atPath: "\(outside)/b", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: "\(stage)/real/b", withIntermediateDirectories: true)
    XCTAssertEqual(symlink(outside, "\(stage)/a"), 0)
    let folder = open(stage, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    defer { close(folder) }
    XCTAssertNil(PluginArchive.openParent(folder, of: "a/b/c"), "a folder swapped for a link on the way down is refused")
    XCTAssertNil(PluginArchive.openParent(folder, of: "real/../a/c"))
    let parent = try XCTUnwrap(PluginArchive.openParent(folder, of: "real/b/c"))
    XCTAssertEqual(parent.name, "c")
    close(parent.folder)
    let archive = try pluginArchive(manifest())
    let planted = "\(root)/stage-planted"
    XCTAssertEqual(mkdir(planted, 0o700), 0)
    XCTAssertEqual(symlink(outside, "\(planted)/bin"), 0)
    XCTAssertNotNil(unpack(archive, into: planted), "a link already where a folder goes stops the unpack")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(outside)/tool"), "nothing is written through it")
  }

  func testGzipAndTarReadersRefuseDamage() throws {
    let archive = try pluginArchive(manifest())
    var bytes = try Data(contentsOf: URL(fileURLWithPath: archive))
    bytes[bytes.count / 2] ^= 0xff
    let damaged = "\(root)/damaged.tar.gz"
    try bytes.write(to: URL(fileURLWithPath: damaged))
    let stage = "\(root)/stage-damaged"
    XCTAssertEqual(mkdir(stage, 0o700), 0)
    XCTAssertNotNil(unpack(damaged, into: stage))
    try Data("not gzip".utf8).write(to: URL(fileURLWithPath: "\(root)/plain.tar.gz"))
    let other = "\(root)/stage-plain"
    XCTAssertEqual(mkdir(other, 0o700), 0)
    XCTAssertEqual(unpack("\(root)/plain.tar.gz", into: other), "the download isn't a gzip file")
  }
}

extension PluginStoreTests {
  func publishedVersion(_ version: String, say: String) throws -> PluginInstaller.Published {
    let archive = try pluginArchive(manifest(version), tool: Data("#!/bin/sh\necho \(say)\n".utf8))
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    return try publish(archive, entry: entry(sha: sha, version: version)).get()
  }

  func testActivatingKeepsTheEarlierCopyAsPreviousAndRollbackSwapsThem() throws {
    let first = try publishedVersion("1.0.0", say: "one")
    let second = try publishedVersion("1.1.0", say: "two")
    XCTAssertEqual(Set(store.candidates(key).map(\.version)), ["1.0.0", "1.1.0"], "copies waiting for approval are listed")
    XCTAssertTrue(store.activate(key, sha: first.copy.sha))
    XCTAssertNil(store.previous(key))
    XCTAssertTrue(store.activate(key, sha: second.copy.sha))
    XCTAssertEqual(store.active(key)?.version, "1.1.0")
    XCTAssertEqual(store.previous(key)?.version, "1.0.0", "the copy it replaced stays for an instant rollback")
    XCTAssertEqual(store.candidates(key), [])
    XCTAssertEqual(store.rollback(key)?.version, "1.0.0")
    XCTAssertEqual(store.active(key)?.version, "1.0.0")
    XCTAssertEqual(store.previous(key)?.version, "1.1.0", "rolling back keeps the newer copy to go forward again")
    store.sweep(key)
    XCTAssertNotNil(store.copy(key, sha: second.copy.sha), "sweeping keeps active and previous")
    XCTAssertEqual(store.keys(), [key])
  }

  func testAStoreCopyLivesUnderItsScopeAndVersion() throws {
    let made = try publishedVersion("2.0.0-beta.1", say: "beta")
    XCTAssertEqual(made.copy.path, "\(root)/Plugins/store/@test/tool/2.0.0-beta.1-\(made.copy.sha.prefix(12))")
    XCTAssertEqual(made.copy.folderId, "store-\(made.copy.sha)")
    XCTAssertEqual(PluginStore.sha(ofFolderId: made.copy.folderId), made.copy.sha)
    XCTAssertNil(PluginStore.parts("tool"), "a store key always names its scope")
    XCTAssertEqual(PluginStore.id("acme__jira"), "@acme/jira")
    XCTAssertNil(PluginStore.entryName(version: "../x", sha: made.copy.sha))
  }

  func testALocalArchiveTakesItsIdFromItsManifestAndRefusesTheOfficialScope() throws {
    let archive = try pluginArchive(manifest("3.1.0"))
    let scratch = "\(root)/scratch-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: scratch, withIntermediateDirectories: true)
    let made = try PluginInstaller.localArchive(archive, scratch: scratch, store: store).get()
    XCTAssertEqual(made.copy.key, key)
    XCTAssertEqual(made.version, "3.1.0")
    let official = try pluginArchive(manifest(id: "@ardia/tool"))
    guard case .failure(let failure) = PluginInstaller.localArchive(official, scratch: scratch, store: store) else { return XCTFail("an @ardia archive was taken from a file") }
    XCTAssertTrue(failure.reason.contains("@ardia"))
    let stray = try gzip(tar([("other/", UInt8(ascii: "5"), Data(), 0o755, ""), ("tool/plugin.json", UInt8(ascii: "0"), Data(manifest().utf8), 0o644, "")]), name: "stray")
    guard case .failure = PluginInstaller.localArchive(stray, scratch: scratch, store: store) else { return XCTFail("an archive spread over two folders was taken") }
  }

  func testSignaturesVerifyWithARawOrSpkiKeyAndNothingElse() throws {
    let key = Curve25519.Signing.PrivateKey()
    let message = Data("ardia-registry-v1\n{}".utf8)
    let signature = try key.signature(for: message)
    let raw = key.publicKey.rawRepresentation
    let spki = Data(PluginSignatures.spkiPrefix) + raw
    let url = { (data: Data) in data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    XCTAssertTrue(PluginSignatures.verify(publicKey: raw.base64EncodedString(), signature: url(signature), message: message.base64EncodedString()))
    XCTAssertTrue(PluginSignatures.verify(publicKey: spki.base64EncodedString(), signature: signature.base64EncodedString(), message: url(message)))
    XCTAssertFalse(PluginSignatures.verify(publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString(), signature: url(signature), message: message.base64EncodedString()))
    XCTAssertFalse(PluginSignatures.verify(publicKey: raw.base64EncodedString(), signature: url(signature), message: Data("other".utf8).base64EncodedString()))
    XCTAssertFalse(PluginSignatures.verify(publicKey: "not a key", signature: url(signature), message: message.base64EncodedString()))
  }

  func officialCopy(_ version: String = "1.2.0") throws -> StoreCopy {
    let archive = try pluginArchive(manifest(version, id: "@ardia/tool"))
    let sha = try XCTUnwrap(PluginArchive.sha256(file: archive))
    let expectation = StoreExpectation(key: "ardia__tool", id: "@ardia/tool", version: version, sha256: sha)
    let scratch = store.makeScratch("ardia__tool", prefix: ".fetch-")!
    defer { PluginPrograms.discard(scratch) }
    try FileManager.default.copyItem(atPath: archive, toPath: "\(scratch)/download.tar.gz")
    return try PluginInstaller.verifyAndPublish(expectation, archive: "\(scratch)/download.tar.gz", scratch: scratch, store: store).get().copy
  }

  func officialSignature(_ signer: Curve25519.Signing.PrivateKey, _ copy: StoreCopy, platform: String = "universal") throws -> OfficialProof {
    let message = try XCTUnwrap(PluginOfficial.message(id: "@ardia/tool", version: copy.version, platform: platform, sha256: copy.sha))
    let signature = try signer.signature(for: message).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    return OfficialProof(platform: platform, signature: signature)
  }

  func testTheOfficialMessageIsTheBytesTheSdkSigns() {
    let sha = String(repeating: "ab", count: 32)
    let message = PluginOfficial.message(id: "@ardia/cli", version: "1.2.3-beta.1", platform: "macos-arm64", sha256: sha)
    XCTAssertEqual(message.map { String(decoding: $0, as: UTF8.self) }, "ardia-official-native-v1\n{\"id\":\"@ardia/cli\",\"platform\":\"macos-arm64\",\"sha256\":\"\(sha)\",\"v\":1,\"version\":\"1.2.3-beta.1\"}")
    XCTAssertNil(PluginOfficial.message(id: "@acme/cli", version: "1.0.0", platform: "universal", sha256: sha), "only @ardia plugins carry an official signature")
    XCTAssertNil(PluginOfficial.message(id: "@ardia/cli", version: "1.0.0\"", platform: "universal", sha256: sha))
    XCTAssertNil(PluginOfficial.message(id: "@ardia/cli", version: "1.0.0", platform: "plan9", sha256: sha))
    XCTAssertEqual(PluginOfficial.keys(override: "kid-1=\(String(repeating: "A", count: 43))=, \(String(repeating: "B", count: 44))"), [String(repeating: "A", count: 43) + "=", String(repeating: "B", count: 44)])
  }

  func testAnOfficialCopyIsTrustedOnlyWithAProofSignedForItsExactDownload() throws {
    let signer = Curve25519.Signing.PrivateKey()
    let keys = [signer.publicKey.rawRepresentation.base64EncodedString()]
    let copy = try officialCopy()
    XCTAssertFalse(store.isOfficial(copy, keys: keys), "an @ardia name alone isn't official")
    let other = try officialCopy("1.3.0")
    XCTAssertTrue(store.recordOfficial(copy, proof: try officialSignature(signer, other)))
    XCTAssertFalse(store.isOfficial(copy, keys: keys), "a signature for another version doesn't carry over")
    XCTAssertTrue(store.recordOfficial(copy, proof: try officialSignature(signer, copy)))
    XCTAssertTrue(store.isOfficial(copy, keys: keys))
    XCTAssertFalse(store.isOfficial(copy, keys: [Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString()]), "another key's signature isn't Ardia's")
    XCTAssertFalse(store.isOfficial(copy, keys: []), "with no official key nothing is official")
    let plain = try publishedVersion("1.0.0", say: "x")
    XCTAssertTrue(store.recordOfficial(plain.copy, proof: try officialSignature(signer, copy)))
    XCTAssertFalse(store.isOfficial(plain.copy, keys: keys), "a proof planted beside a non-@ardia copy isn't trusted")
    XCTAssertTrue(store.activate("ardia__tool", sha: copy.sha))
    store.sweep("ardia__tool")
    XCTAssertTrue(store.isOfficial(try XCTUnwrap(store.active("ardia__tool")), keys: keys), "sweeping keeps the active copy's proof")
    XCTAssertNil(store.copy("ardia__tool", sha: other.sha).flatMap(store.officialProof), "sweeping drops proofs of removed copies")
  }

  func testAnActivationThatCantKeepTheEarlierCopyChangesNothing() throws {
    let first = try publishedVersion("1.0.0", say: "one")
    let second = try publishedVersion("1.1.0", say: "two")
    XCTAssertTrue(store.activate(key, sha: first.copy.sha))
    let previous = "\(root)/Plugins/store/@test/tool/previous"
    try FileManager.default.createDirectory(atPath: "\(previous)/held", withIntermediateDirectories: true)
    XCTAssertFalse(store.activate(key, sha: second.copy.sha), "a switch that would lose the rollback copy fails")
    XCTAssertEqual(store.active(key)?.version, "1.0.0", "the active copy is unchanged")
    try FileManager.default.removeItem(atPath: previous)
    XCTAssertTrue(store.activate(key, sha: second.copy.sha))
    XCTAssertEqual(store.previous(key)?.version, "1.0.0")
  }

  func folderWith(_ files: [String: String]) throws -> String {
    let folder = "\(root)/folder-\(UUID().uuidString)"
    for (path, text) in files {
      let file = (folder as NSString).appendingPathComponent(path)
      try FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
      try Data(text.utf8).write(to: URL(fileURLWithPath: file))
    }
    return folder
  }

  func digest(_ folder: String) throws -> Result<String, PluginFolderDigest.Failure> {
    let opened = try XCTUnwrap(PluginFiles.openFolder(folder))
    defer { opened.close() }
    return PluginFolderDigest.digest(opened.fd)
  }

  func testAFolderDigestCoversEveryFileAndRefusesLinks() throws {
    let files = ["plugin.json": manifest(), "main.js": "run()", "lib/a.js": "a"]
    let one = try folderWith(files)
    let two = try folderWith(files)
    let first = try digest(one).get()
    XCTAssertEqual(try digest(two).get(), first, "the digest depends only on paths and bytes")
    try Data("x".utf8).write(to: URL(fileURLWithPath: "\(one)/.DS_Store"))
    XCTAssertEqual(try digest(one).get(), first, "Finder's .DS_Store doesn't change it")
    try Data("evil()".utf8).write(to: URL(fileURLWithPath: "\(two)/lib/a.js"))
    XCTAssertNotEqual(try digest(two).get(), first, "a changed script that isn't plugin.json changes it")
    try Data("b".utf8).write(to: URL(fileURLWithPath: "\(one)/lib/b.js"))
    XCTAssertNotEqual(try digest(one).get(), first, "an added file changes it")
    let linked = try folderWith(files)
    try FileManager.default.createSymbolicLink(atPath: "\(linked)/lib/escape.js", withDestinationPath: "/etc/hosts")
    XCTAssertEqual(try digest(linked), .failure(.special("lib/escape.js")))
  }

  func testAnApprovedFolderIsBoundToItsWholeDigest() throws {
    let folder = try folderWith(["plugin.json": manifest(), "main.js": "run()"])
    let opened = try XCTUnwrap(PluginFiles.openFolder(folder))
    let folderId = try PluginFiles.digestedFolder(opened).get().id
    opened.close()
    XCTAssertTrue(folderId.hasPrefix("local-"))
    let approved = PluginFiles.approvalHash(text: manifest(), folderId: folderId)
    guard case .success(let ok) = PluginFiles.approvedFolder(folder, folderId: folderId, approved: approved, digested: true) else { return XCTFail("the approved folder didn't open") }
    ok.close()
    XCTAssertNotNil(PluginFiles.readPageFile(folder, folderId: folderId, approved: approved, relative: "main.js", digested: true))
    try Data("evil()".utf8).write(to: URL(fileURLWithPath: "\(folder)/main.js"))
    guard case .failure = PluginFiles.approvedFolder(folder, folderId: folderId, approved: approved, digested: true) else { return XCTFail("a folder whose script changed after approval still opened") }
    XCTAssertNil(PluginFiles.readPageFile(folder, folderId: folderId, approved: approved, relative: "main.js", digested: true))
  }

  func testHostileFileNamesAreDigestedByTheirBytesAndRenamingChangesTheDigest() throws {
    let names = ["new\nline.js", "ünïcode.js", " lead space.js", "tab\there.js", String(repeating: "x", count: 200) + ".js", "-dash.js", "back\\slash.js"]
    let folder = try folderWith(Dictionary(uniqueKeysWithValues: (names + ["plugin.json"]).map { ($0, $0 == "plugin.json" ? manifest() : "body") }))
    let first = try digest(folder).get()
    try FileManager.default.moveItem(atPath: "\(folder)/ünïcode.js", toPath: "\(folder)/unicode.js")
    XCTAssertNotEqual(try digest(folder).get(), first, "a renamed file is another folder")
    let fifo = "\(folder)/pipe"
    XCTAssertEqual(mkfifo(fifo, 0o600), 0)
    XCTAssertEqual(try digest(folder), .failure(.special("pipe")))
  }

  func testProfileDataPathsTakeOnlyAProfileIdAndAPluginKey() {
    XCTAssertEqual(PluginDataPaths.relative("acme__tool"), "acme__tool")
    XCTAssertEqual(PluginDataPaths.relative("profiles/p-1x-2/acme__tool"), "profiles/p-1x-2/acme__tool")
    for hostile in ["profiles", "profiles/../acme__tool", "profiles/p/../../x", "profiles//acme__tool", "profiles/p/acme__tool/extra", "../acme__tool", "profiles/p\u{0}/acme__tool", "profiles/p.q/acme__tool", "/abs", ""] {
      XCTAssertNil(PluginDataPaths.relative(hostile), hostile)
    }
  }

  func testAFolderNamedDSStoreIsDigestedLikeAnyOther() throws {
    let folder = try folderWith(["plugin.json": manifest(), "main.js": "run()"])
    let first = try digest(folder).get()
    try FileManager.default.createDirectory(atPath: "\(folder)/.DS_Store", withIntermediateDirectories: true)
    try Data("evil()".utf8).write(to: URL(fileURLWithPath: "\(folder)/.DS_Store/payload.js"))
    XCTAssertNotEqual(try digest(folder).get(), first, "a loadable subtree under a folder named .DS_Store is covered")
  }

  func testAnUnsignedOfficialNativeCandidateIsNeverActivated() throws {
    let signer = Curve25519.Signing.PrivateKey()
    let keys = [signer.publicKey.rawRepresentation.base64EncodedString()]
    let copy = try officialCopy()
    let text = try XCTUnwrap(manifestOf(copy.path))
    let approved = PluginFiles.approvalHash(text: text, folderId: copy.folderId)
    XCTAssertEqual(PluginInstaller.activate("ardia__tool", folderId: copy.folderId, approved: approved, store: store, officialKeys: keys), "It reaches outside Ardia's sandbox but isn't signed by Ardia's release key, so it wasn't switched to.")
    XCTAssertNil(store.active("ardia__tool"))
    XCTAssertTrue(store.recordOfficial(copy, proof: try officialSignature(signer, copy)))
    XCTAssertNil(PluginInstaller.activate("ardia__tool", folderId: copy.folderId, approved: approved, store: store, officialKeys: keys))
    XCTAssertEqual(store.active("ardia__tool"), copy)
  }

  func manifestOf(_ path: String) -> String? {
    guard let opened = PluginFiles.openFolder(path) else { return nil }
    defer { opened.close() }
    if case .text(let text) = PluginFiles.readManifest(in: opened) { return text }
    return nil
  }

  func testRollbackSwitchesOnlyToTheCopyArdiaChecked() throws {
    let first = try publishedVersion("1.0.0", say: "one")
    let second = try publishedVersion("1.1.0", say: "two")
    XCTAssertTrue(store.activate(key, sha: first.copy.sha))
    XCTAssertTrue(store.activate(key, sha: second.copy.sha))
    XCTAssertNil(store.rollback(key, expectedVersion: "0.9.0", expectedSha: first.copy.sha), "another version isn't switched to")
    XCTAssertNil(store.rollback(key, expectedVersion: "1.0.0", expectedSha: second.copy.sha), "another digest isn't switched to")
    XCTAssertEqual(store.active(key)?.version, "1.1.0")
    XCTAssertEqual(store.rollback(key, expectedVersion: "1.0.0", expectedSha: first.copy.sha)?.version, "1.0.0")
  }
}
