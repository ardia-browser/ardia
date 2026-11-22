import XCTest

@testable import ArdiaPluginCore

final class OfficialPluginsTests: XCTestCase {
  var root = ""
  var store: OfficialStore!
  var places: ProgramPlaces!

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("official-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = PluginSandbox.resolved(made.path)!
    store = OfficialStore(root: "\(root)/OfficialPlugins")
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

  func manifest(_ version: String = "1.2.0", claim: Bool = false) -> String {
    #"{"manifest":2,"name":"tool","version":"\#(version)","official":true,"contributes":{"programs":[{"name":"tool","path":"bin/tool"\#(claim ? #","claim":true"# : "")}]}}"#
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

  func entry(sha: String, reserved: [String] = []) -> OfficialPinEntry {
    OfficialPinEntry(name: "tool", version: "1.2.0", url: URL(string: "https://example.invalid/tool.tar.gz")!, sha256: sha, reservedPrograms: reserved, legacyInstall: nil)
  }

  func publish(_ archive: String, entry: OfficialPinEntry, registry: ProgramRegistry = .empty) -> Result<(copy: OfficialCopy, manifest: String), OfficialInstaller.Failure> {
    let scratch = store.makeScratch("tool", prefix: ".fetch-")!
    defer { PluginPrograms.discard(scratch) }
    let download = "\(scratch)/download.tar.gz"
    try? FileManager.default.copyItem(atPath: archive, toPath: download)
    return OfficialInstaller.verifyAndPublish(entry, archive: download, scratch: scratch, store: store, registry: registry)
  }

  func testAPlantedActiveCopyThatNoSignedPinNamesIsNotOfficialWhateverPluginsJsonSays() throws {
    let planted = try pluginArchive(manifest(), tool: Data("#!/bin/sh\necho planted\n".utf8))
    let plantedSha = try XCTUnwrap(OfficialArchive.sha256(file: planted))
    let made = try publish(planted, entry: entry(sha: plantedSha)).get()
    XCTAssertTrue(store.activate("tool", sha: plantedSha), "the copy is internally consistent: its download matches its own SHA-256")
    XCTAssertNotNil(store.active("tool"))
    let pin = OfficialPin(entries: [entry(sha: String(repeating: "6", count: 64))])
    let signed = try XCTUnwrap(pin.entry("tool"))
    XCTAssertNil(OfficialTrust.trustedActive(store, signed), "active only selects among copies a signed pin vouches for")
    XCTAssertNil(OfficialTrust.copy(store, name: "tool", folderId: made.copy.folderId, pin: pin), "no record, forged or not, makes it official")
    XCTAssertNil(OfficialTrust.copy(store, name: "tool", folderId: made.copy.folderId, pin: nil))
    var earlier = signed
    earlier.trustedArtifacts = [plantedSha]
    let history = OfficialPin(entries: [earlier])
    XCTAssertEqual(OfficialTrust.copy(store, name: "tool", folderId: made.copy.folderId, pin: history)?.sha, plantedSha, "an earlier pinned artifact the signed history lists stays official")
    XCTAssertEqual(OfficialTrust.trustedActive(store, earlier)?.sha, plantedSha)
  }

  func testThe0247CopyCountsOnlyWhileItIsTheOneAReleaseShipped() throws {
    let old = try makeFolder("0.4.0", say: "old")
    defer { old.close() }
    _ = try install(old, version: "0.4.0", identity: OfficialPin.legacyFolderId)
    let kept = try XCTUnwrap(PluginPrograms.legacyCopy(plugin: "tool", places: places))
    let shipped = try XCTUnwrap(PluginPrograms.payloadDigest(kept))
    XCTAssertTrue(OfficialTrust.bundledCopyHolds(kept, digests: [shipped]), "0.2.47's kept copy is official because its bytes are the ones 0.2.47 shipped")
    XCTAssertFalse(OfficialTrust.bundledCopyHolds(kept, digests: []), "with no shipped digest nothing counts")
    XCTAssertFalse(OfficialTrust.bundledCopyHolds(kept, digests: [String(repeating: "7", count: 64)]))
    try tamper("\(kept)/bin/tool", "#!/bin/sh\necho planted\n")
    XCTAssertFalse(OfficialTrust.bundledCopyHolds(kept, digests: [shipped]), "a copy under the old identity whose bytes changed isn't official")
    XCTAssertEqual(
      PluginPrograms.dropCurrentUnlessTrusted(plugin: "tool", programs: toolPrograms, places: places, trusted: [], bundledDigests: [shipped]), .dropped,
      "and it comes off PATH")
  }

  func testThePinIsReadFromOfficialPluginsJsonAsIs() throws {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../apps/browser/official-plugins.json")
    let doc = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
    let pin = try XCTUnwrap(OfficialPin.parse(doc))
    let cli = try XCTUnwrap(pin.entry("cli"))
    XCTAssertTrue(cli.url.absoluteString.hasPrefix("https://github.com/ardia-browser/plugins/releases/download/cli-v"))
    XCTAssertEqual(cli.url.lastPathComponent, cli.file)
    XCTAssertEqual(cli.folderId, "official-\(cli.sha256)")
    XCTAssertEqual((pin.registryDocument["claims"] as? [String: String])?["ardia"], "cli")
    let bare: [String: Any] = ["version": 1, "plugins": [["name": "x", "version": "1.0.0", "release": "https://example.invalid/r", "artifacts": ["macos-arm64": ["file": "x.tar.gz", "sha256": NSNull()]]]]]
    XCTAssertEqual(OfficialPin.parse(bare)?.entries, [], "an artifact not published yet can't be fetched")
    var http = bare
    http["plugins"] = [["name": "x", "version": "1.0.0", "release": "http://example.invalid/r", "artifacts": ["macos-arm64": ["file": "x.tar.gz", "sha256": String(repeating: "a", count: 64)]]]]
    XCTAssertNil(OfficialPin.parse(http), "only https")
    var clash = bare
    clash["plugins"] = ["a", "b"].map { ["name": $0, "version": "1.0.0", "release": "https://example.invalid/r", "reservedPrograms": ["same"], "artifacts": ["macos-arm64": ["file": "\($0).tar.gz", "sha256": String(repeating: "a", count: 64)]]] }
    XCTAssertNil(OfficialPin.parse(clash), "two plugins can't reserve one program")
    var trusted = bare
    let a = String(repeating: "a", count: 64)
    let b = String(repeating: "b", count: 64)
    trusted["plugins"] = [["name": "x", "version": "1.0.0", "release": "https://example.invalid/r", "artifacts": ["macos-arm64": ["file": "x.tar.gz", "sha256": a]], "trusted": ["artifacts": [b], "bundledDigests": [a]]]]
    let read = try XCTUnwrap(OfficialPin.parse(trusted)?.entry("x"))
    XCTAssertEqual([read.trustedArtifacts, read.bundledDigests], [[b], [a]])
    XCTAssertTrue(read.trusts(a) && read.trusts(b))
    XCTAssertFalse(read.trusts(String(repeating: "c", count: 64)))
    var bad = trusted
    bad["plugins"] = [["name": "x", "version": "1.0.0", "release": "https://example.invalid/r", "artifacts": ["macos-arm64": ["file": "x.tar.gz", "sha256": a]], "trusted": ["artifacts": ["not-a-sha"]]]]
    XCTAssertNil(OfficialPin.parse(bad), "a malformed trusted list refuses the whole pin")
    let signedURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../apps/browser/official-plugins-history.json")
    let history = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: signedURL)) as? [String: Any])
    XCTAssertEqual(history["version"] as? Int, 1)
  }

  func testAVerifiedDownloadIsPublishedByDigestAndStaysOutOfTheActiveCopyUntilPromoted() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertEqual(made.copy.path, "\(root)/OfficialPlugins/tool/\(sha)")
    XCTAssertEqual(made.copy.payloadDigest, PluginPrograms.payloadDigest(made.copy.path))
    XCTAssertNil(store.active("tool"), "a candidate isn't active until the user confirms")
    XCTAssertFalse(hasQuarantine("\(made.copy.path)/bin/tool"), "the copy isn't quarantined, so Gatekeeper never asks to notarize it")
    let approved = PluginFiles.approvalHash(text: made.manifest, folderId: made.copy.folderId)
    let pin = OfficialPin(entries: [entry(sha: sha)])
    XCTAssertEqual(OfficialInstaller.promote("tool", folderId: made.copy.folderId, approved: "0" + approved.dropFirst(), store: store, pin: pin), "It changed since you approved it. Try again.")
    XCTAssertNil(store.active("tool"))
    XCTAssertNil(OfficialInstaller.promote("tool", folderId: made.copy.folderId, approved: approved, store: store, pin: pin))
    XCTAssertEqual(store.active("tool"), made.copy)
    let again = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertEqual(again.copy, made.copy, "the same download is reused, not replaced")
  }

  func testPromotionTakesOnlyTheExactApprovalOfTheDownload() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    let pin = OfficialPin(entries: [entry(sha: sha)])
    let old = PluginFiles.approvalHash(text: made.manifest, folderId: OfficialPin.legacyFolderId)
    XCTAssertNotNil(OfficialInstaller.promote("tool", folderId: made.copy.folderId, approved: old, store: store, pin: pin), "the old receipt is turned into an exact approval before any switch, never used for one")
    XCTAssertNil(OfficialInstaller.promote("tool", folderId: made.copy.folderId, approved: PluginFiles.approvalHash(text: made.manifest, folderId: made.copy.folderId), store: store, pin: pin))
  }

  func testASha256MismatchIsRefusedAndLeavesNothing() throws {
    let archive = try pluginArchive(manifest())
    let result = publish(archive, entry: entry(sha: String(repeating: "0", count: 64)))
    guard case .failure(let failure) = result else { return XCTFail("a mismatch was published") }
    XCTAssertEqual(failure.code, "verify")
    XCTAssertTrue(failure.reason.contains("doesn't match"))
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: "\(root)/OfficialPlugins/tool").filter { !$0.hasPrefix(".fetch-") && !$0.hasPrefix(".trash-") }, [])
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
      let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
      guard case .failure(let failure) = publish(archive, entry: entry(sha: sha)) else { return XCTFail("\(bad.0) was accepted") }
      XCTAssertEqual(failure.code, "verify", bad.0)
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/OfficialPlugins/escaped"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/escaped"))
  }

  func testAManifestThatIsntThePinnedVersionOrClaimsAnotherNameIsRefused() throws {
    for (text, why) in [(manifest("9.9.9"), "version"), (manifest(claim: true), "claims")] {
      let archive = try pluginArchive(text)
      let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
      guard case .failure(let failure) = publish(archive, entry: entry(sha: sha)) else { return XCTFail(why) }
      XCTAssertEqual(failure.code, "verify", why)
    }
    let archive = try pluginArchive(manifest(claim: true))
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    let registry = ProgramRegistry(claims: ["tool": "tool"], legacy: [], failClosed: false)
    XCTAssertNoThrow(try publish(archive, entry: entry(sha: sha, reserved: ["tool"]), registry: registry).get(), "a claim the pin and registry both give it is fine")
  }

  let toolPrograms = [PluginProgram(name: "tool", path: "bin/tool")]

  func linkedOfficialCopy() throws -> (copy: OfficialCopy, manifest: String, source: TrustedProgramCopy) {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
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
    getxattr(path, OfficialStore.quarantineName, nil, 0, 0, XATTR_NOFOLLOW) >= 0
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
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
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
    XCTAssertEqual(setxattr(archive, OfficialStore.quarantineName, "0081;0;Test;", 12, 0, XATTR_NOFOLLOW), 0)
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    guard case .failure = publish(archive, entry: entry(sha: String(repeating: "1", count: 64))) else { return XCTFail("a mismatch was published") }
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertFalse(hasQuarantine("\(made.copy.path)/bin/tool"))
    XCTAssertFalse(hasQuarantine("\(made.copy.path)/plugin.json"))
  }

  func testLinkingRefusesAProgramCopyThatIsntTheVerifiedDownload() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
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

  func testOnlyACopyMadeUnderTheOldIdentityCountsAsTheEarlierInstall() throws {
    let fetched = try makeFolder("0.5.0", say: "fetched")
    defer { fetched.close() }
    _ = try install(fetched, version: "0.5.0", identity: "official-\(String(repeating: "a", count: 64))")
    XCTAssertNil(PluginPrograms.legacyCopy(plugin: "tool", places: places), "a fetched program copy whose download failed verification isn't an earlier install")
  }

  func testTheOldCopyIsKeptLinkedInPlaceWithoutRestaging() throws {
    let old = try makeFolder("0.4.0", say: "old")
    defer { old.close() }
    _ = try install(old, version: "0.4.0", identity: OfficialPin.legacyFolderId)
    let version = try XCTUnwrap(PluginPrograms.linkTarget("\(places.store)/tool/current"))
    XCTAssertEqual(PluginPrograms.legacyCopy(plugin: "tool", places: places), "\(places.store)/tool/\(version)")
    unlink("\(places.binDir)/tool")
    let kept = try PluginPrograms.keepLegacy(plugin: "tool", programs: [PluginProgram(name: "tool", path: "bin/tool")], places: places).get()
    XCTAssertEqual(kept.linked, ["tool"])
    XCTAssertEqual(kept.kept, version)
    XCTAssertEqual(PluginPrograms.linkTarget("\(places.store)/tool/current"), version, "nothing restaged or switched")
    XCTAssertEqual(PluginPrograms.linkTarget("\(places.binDir)/tool"), "\(places.store)/tool/current/bin/tool")
    PluginPrograms.withdrawAllBut(["tool"], places: places)
    XCTAssertNotNil(PluginPrograms.linkTarget("\(places.binDir)/tool"), "the launch sweep keeps an owner it's told to keep")
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
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    try FileManager.default.createDirectory(atPath: "\(root)/OfficialPlugins/tool/\(sha)", withIntermediateDirectories: true)
    XCTAssertNil(store.copy("tool", sha: sha), "a folder without its download is a crash between files, not a copy")
    let orphan = String(repeating: "c", count: 64)
    try Data("x".utf8).write(to: URL(fileURLWithPath: "\(root)/OfficialPlugins/tool/\(orphan).tar.gz"))
    store.sweep("tool", keeping: [sha])
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/OfficialPlugins/tool/\(orphan).tar.gz"), "a download whose folder never arrived is dropped")
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(root)/OfficialPlugins/tool/\(sha)"), "a folder with no download is dropped")
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertEqual(store.copy("tool", sha: sha), made.copy)
    XCTAssertTrue(FileManager.default.fileExists(atPath: "\(made.copy.path)/plugin.json"))
    XCTAssertTrue(store.activate("tool", sha: sha))
    XCTAssertTrue(store.remove("tool"))
    XCTAssertNil(store.active("tool"))
  }

  func testACopyThatNoLongerMatchesItsPinnedDownloadIsNotOfficial() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    try tamper("\(made.copy.path)/bin/tool", "#!/bin/sh\necho swapped\n")
    let approved = PluginFiles.approvalHash(text: made.manifest, folderId: made.copy.folderId)
    XCTAssertNil(store.copy("tool", sha: sha), "an edit inside a copy already checked this launch is still noticed")
    XCTAssertNotNil(OfficialInstaller.promote("tool", folderId: made.copy.folderId, approved: approved, store: store, pin: OfficialPin(entries: [entry(sha: sha)])), "promotion re-verifies against the download")
    let other = try pluginArchive(manifest("1.2.0"), tool: Data("#!/bin/sh\necho other\n".utf8))
    try FileManager.default.removeItem(atPath: "\(root)/OfficialPlugins/tool/\(sha).tar.gz")
    try FileManager.default.copyItem(atPath: other, toPath: "\(root)/OfficialPlugins/tool/\(sha).tar.gz")
    OfficialVerification.shared.forget()
    XCTAssertNil(store.copy("tool", sha: sha), "a download that isn't the pinned SHA-256 vouches for nothing")
  }

  func testAFailedSwitchKeepsACopyOnlyWhileItMatchesTheCheckedCopyItCameFrom() throws {
    let old = try makeFolder("0.4.0", say: "old")
    defer { old.close() }
    _ = try install(old, version: "0.4.0", identity: OfficialPin.legacyFolderId)
    let kept = try XCTUnwrap(PluginPrograms.legacyCopy(plugin: "tool", places: places))
    let bundled = try XCTUnwrap(PluginPrograms.payloadDigest(kept))
    XCTAssertEqual(
      PluginPrograms.dropCurrentUnlessTrusted(plugin: "tool", programs: toolPrograms, places: places, trusted: [], bundledDigests: [bundled]), .trusted,
      "a failed update leaves 0.2.47's ardia on PATH when its copy is the one 0.2.47 shipped")
    XCTAssertNotNil(PluginPrograms.linkTarget("\(places.binDir)/tool"))

    let first = try pluginArchive(manifest())
    let firstSha = try XCTUnwrap(OfficialArchive.sha256(file: first))
    let earlier = try publish(first, entry: entry(sha: firstSha)).get()
    let second = try pluginArchive(manifest(), tool: Data("#!/bin/sh\necho second\n".utf8))
    let secondSha = try XCTUnwrap(OfficialArchive.sha256(file: second))
    let later = try publish(second, entry: entry(sha: secondSha)).get()
    let source = { (made: (copy: OfficialCopy, manifest: String)) in
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
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
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

  func testTurningAnOfficialPluginOffKeepsItsCopySoItCanTurnBackOn() throws {
    let old = try makeFolder("0.4.0", say: "old")
    defer { old.close() }
    _ = try install(old, version: "0.4.0", identity: OfficialPin.legacyFolderId)
    let version = try XCTUnwrap(PluginPrograms.linkTarget("\(places.store)/tool/current"))
    PluginPrograms.withdraw(plugin: "tool", programs: ["tool"], places: places, keepCopy: true)
    XCTAssertNil(PluginPrograms.linkTarget("\(places.binDir)/tool"), "off takes it off PATH")
    XCTAssertEqual(PluginPrograms.linkTarget("\(places.store)/tool/current"), version, "but keeps the copy an earlier Ardia made")
    PluginPrograms.withdrawAllBut([], places: places, keepingCopies: ["tool"])
    XCTAssertEqual(PluginPrograms.legacyCopy(plugin: "tool", places: places), "\(places.store)/tool/\(version)", "the launch sweep keeps it too")
    let back = try PluginPrograms.keepLegacy(plugin: "tool", programs: [PluginProgram(name: "tool", path: "bin/tool")], places: places).get()
    XCTAssertEqual(back.linked, ["tool"])
  }

  func testNamesOutsideTheDigestAreRefusedAndPlantedOnesBreakTheMatch() throws {
    for bad in [("tool/__pycache__/x.pyc", UInt8(ascii: "0"), Data("x".utf8), 0o644, ""), ("tool/.leases/1", UInt8(ascii: "0"), Data(), 0o644, "")] {
      let archive = try pluginArchive(manifest(), extra: [bad])
      let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
      guard case .failure(let failure) = publish(archive, entry: entry(sha: sha)) else { return XCTFail("\(bad.0) was accepted") }
      XCTAssertEqual(failure.code, "verify")
    }
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertEqual(chmod("\(made.copy.path)/bin", 0o755), 0)
    try FileManager.default.createDirectory(atPath: "\(made.copy.path)/bin/__pycache__", withIntermediateDirectories: true)
    try "x".write(toFile: "\(made.copy.path)/bin/__pycache__/planted.pyc", atomically: true, encoding: .utf8)
    XCTAssertNil(store.copy("tool", sha: sha), "a planted cache file isn't skipped by an official copy's digest")
  }

  func testAnUnpinnedActiveCopyIsntApprovedByTheOldReceiptAndADamagedOneCanBeRepaired() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertTrue(store.activate("tool", sha: sha))
    let newer = OfficialPin(entries: [entry(sha: String(repeating: "e", count: 64))])
    let oldReceipt = PluginFiles.approvalHash(text: made.manifest, folderId: OfficialPin.legacyFolderId)
    XCTAssertNotNil(OfficialInstaller.promote("tool", folderId: made.copy.folderId, approved: oldReceipt, store: store, pin: newer), "the old receipt vouches only for the pinned bytes")
    XCTAssertNil(OfficialInstaller.promote("tool", folderId: made.copy.folderId, approved: PluginFiles.approvalHash(text: made.manifest, folderId: made.copy.folderId), store: store, pin: newer), "its own exact approval still holds")
    try tamper("\(made.copy.path)/bin/tool", "#!/bin/sh\necho damaged\n")
    XCTAssertNil(store.active("tool"))
    let repaired = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertEqual(store.active("tool"), repaired.copy, "a clean download of the same pinned file replaces a damaged active copy")
  }

  func testAFailedFreshCheckClearsTheRecentCheck() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertNotNil(store.copy("tool", sha: sha))
    try tamper("\(made.copy.path)/bin/tool", "#!/bin/sh\necho swapped\n")
    XCTAssertNil(store.copy("tool", sha: sha, fresh: true))
    XCTAssertNil(store.copy("tool", sha: sha), "a mismatch found by a fresh check isn't hidden by the recent good one")
  }

  func testAPublishedCopyIsReadOnlyInAPrivateFolder() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    var info = stat()
    XCTAssertEqual(lstat(made.copy.path, &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o555)
    XCTAssertEqual(lstat("\(made.copy.path)/bin/tool", &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o555)
    XCTAssertEqual(lstat("\(made.copy.path)/plugin.json", &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o444)
    XCTAssertEqual(lstat(store.archivePath("tool", sha), &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o444)
    let scratch = try XCTUnwrap(store.makeScratch("tool", prefix: ".stage-"))
    XCTAssertEqual(lstat(scratch, &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o700, "unpacking happens in a folder only Ardia's user can enter")
    XCTAssertTrue(store.remove("tool"), "removal unseals what it deletes")
  }

  func testACopyMadeWritableAgainIsNoLongerTrusted() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
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
    OfficialVerification.shared.forget()
    XCTAssertNil(store.copy("tool", sha: sha), "a published copy that can be written is not official")
  }

  func testNothingIsUnpackedUnderAFolderOtherUsersCanRename() throws {
    let shared = "\(root)/shared"
    XCTAssertEqual(mkdir(shared, 0o755), 0)
    XCTAssertEqual(chmod(shared, 0o777), 0)
    let exposed = OfficialStore(root: "\(shared)/OfficialPlugins")
    XCTAssertNil(exposed.makeScratch("tool", prefix: ".stage-"), "another user could swap the folder out before it is unpacked into")
    XCTAssertEqual(chmod(shared, 0o1777), 0)
    XCTAssertNotNil(exposed.makeScratch("tool", prefix: ".stage-"), "a sticky folder like /tmp keeps its entries to their owners")
    XCTAssertEqual(chmod(shared, 0o755), 0)
    let acl = Process()
    acl.executableURL = URL(fileURLWithPath: "/bin/chmod")
    acl.arguments = ["+a", "everyone allow add_file,add_subdirectory,delete_child", shared]
    try acl.run()
    acl.waitUntilExit()
    XCTAssertEqual(acl.terminationStatus, 0)
    XCTAssertNil(exposed.makeScratch("tool", prefix: ".stage-"), "an ACL can hand others the folder even though its mode says 0755")
    let denyOnly = Process()
    denyOnly.executableURL = URL(fileURLWithPath: "/bin/chmod")
    denyOnly.arguments = ["-N", shared]
    try denyOnly.run()
    denyOnly.waitUntilExit()
    XCTAssertNotNil(exposed.makeScratch("tool", prefix: ".stage-"))
  }

  func testAStoreReachedThroughASymlinkIsntUnpackedInto() throws {
    let real = "\(root)/elsewhere"
    XCTAssertEqual(mkdir(real, 0o700), 0)
    XCTAssertEqual(symlink(real, "\(root)/Linked"), 0)
    let linked = OfficialStore(root: "\(root)/Linked")
    XCTAssertNil(linked.makeScratch("tool", prefix: ".stage-"), "the folder checked and the folder unpacked into could differ")
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

  func testThe0247CopyIsntKeptInAProgramsFolderOtherUsersCanChange() throws {
    let old = try makeFolder("0.4.0", say: "old")
    defer { old.close() }
    _ = try install(old, version: "0.4.0", identity: OfficialPin.legacyFolderId)
    XCTAssertEqual(chmod(root, 0o777), 0)
    defer { chmod(root, 0o700) }
    guard case .failure(let refusal) = PluginPrograms.keepLegacy(plugin: "tool", programs: toolPrograms, places: places) else { return XCTFail("kept a copy another user could swap") }
    XCTAssertTrue(refusal.reason.contains("other users"))
    XCTAssertEqual(PluginPrograms.dropCurrentUnlessTrusted(plugin: "tool", programs: toolPrograms, places: places, trusted: []), .dropped)
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
    XCTAssertEqual(setxattr(archive, OfficialStore.quarantineName, "0081;0;Test;", 12, 0, XATTR_NOFOLLOW), 0)
    let scratch = try XCTUnwrap(store.makeScratch("tool", prefix: ".fetch-"))
    let result = OfficialInstaller.verifyAndPublish(entry(sha: String(repeating: "1", count: 64)), archive: archive, scratch: scratch, store: store, registry: .empty)
    guard case .failure(let failure) = result else { return XCTFail("a mismatch was published") }
    XCTAssertEqual(failure.code, "verify")
    XCTAssertTrue(hasQuarantine(archive), "nothing is cleared before the SHA-256 matches")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: scratch), [], "nothing was unpacked")
  }

  func testAQuarantinedArchiveIsClearedToo() throws {
    let archive = try pluginArchive(manifest())
    XCTAssertEqual(setxattr(archive, OfficialStore.quarantineName, "0081;0;Test;", 12, 0, XATTR_NOFOLLOW), 0)
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    _ = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertFalse(hasQuarantine(store.archivePath("tool", sha)))
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
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: "\(root)/packed.tar.gz"))
    let made = try publish("\(root)/packed.tar.gz", entry: entry(sha: sha)).get()
    XCTAssertEqual(try String(contentsOfFile: "\(made.copy.path)/\(String(deep.dropFirst(5)))/file-with-a-long-name-too.txt", encoding: .utf8), "deep")
    XCTAssertTrue(FileManager.default.isExecutableFile(atPath: "\(made.copy.path)/bin/tool"))
  }

  func unpack(_ archive: String, into stage: String) -> String? {
    guard let held = OfficialArchive.snapshot(archive, in: root) else { return "no snapshot" }
    defer { held.close() }
    let folder = open(stage, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard folder >= 0 else { return "no stage" }
    defer { close(folder) }
    return OfficialArchive.unpack(held.fd, top: "tool", into: folder, scratch: root)
  }

  func testTheBytesHashedAreTheBytesUnpackedEvenIfTheDownloadChangesAfterward() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    let held = try XCTUnwrap(OfficialArchive.snapshot(archive, in: root))
    defer { held.close() }
    XCTAssertEqual(held.sha, sha)
    var info = stat()
    XCTAssertEqual(fstat(held.fd, &info), 0)
    XCTAssertEqual(info.st_nlink, 0, "the snapshot has no path, so nothing can open it again")
    let other = try pluginArchive(manifest(), tool: Data("#!/bin/sh\necho other\n".utf8))
    try FileManager.default.removeItem(atPath: archive)
    try FileManager.default.copyItem(atPath: other, toPath: archive)
    let stage = try XCTUnwrap(store.makeScratch("tool", prefix: ".stage-"))
    let folder = open(stage, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    defer { close(folder) }
    XCTAssertNil(OfficialArchive.unpack(held.fd, top: "tool", into: folder, scratch: root))
    XCTAssertEqual(try String(contentsOfFile: "\(stage)/bin/tool", encoding: .utf8), "#!/bin/sh\necho hi\n", "what is unpacked is what was hashed, not what the path holds now")
    let made = try store.publish("tool", staged: stage, archive: held, sha: sha).get()
    XCTAssertEqual(OfficialArchive.sha256(file: store.archivePath("tool", sha)), sha, "the kept download is written from the verified bytes")
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
    XCTAssertNil(OfficialArchive.openParent(folder, of: "a/b/c"), "a folder swapped for a link on the way down is refused")
    XCTAssertNil(OfficialArchive.openParent(folder, of: "real/../a/c"))
    let parent = try XCTUnwrap(OfficialArchive.openParent(folder, of: "real/b/c"))
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
