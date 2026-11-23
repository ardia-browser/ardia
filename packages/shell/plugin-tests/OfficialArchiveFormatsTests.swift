import Compression
import XCTest

@testable import ArdiaPluginCore

extension OfficialPluginsTests {
  func brotli(_ data: Data, name: String) throws -> String {
    var encoded = [UInt8](repeating: 0, count: data.count + 4096)
    let count = data.withUnsafeBytes { raw in
      compression_encode_buffer(&encoded, encoded.count, raw.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_BROTLI)
    }
    XCTAssertGreaterThan(count, 0)
    let path = "\(root)/\(name).tar.br"
    try Data(encoded.prefix(count)).write(to: URL(fileURLWithPath: path))
    return path
  }

  func toolEntries(_ manifestText: String) -> [(name: String, type: UInt8, body: Data, mode: Int, link: String)] {
    [
      ("tool/", UInt8(ascii: "5"), Data(), 0o755, ""),
      ("tool/bin/", UInt8(ascii: "5"), Data(), 0o755, ""),
      ("tool/plugin.json", UInt8(ascii: "0"), Data(manifestText.utf8), 0o644, ""),
      ("tool/bin/tool", UInt8(ascii: "0"), Data("#!/bin/sh\necho hi\n".utf8), 0o755, ""),
    ]
  }

  func testABrotliArchiveInstallsToTheSameCopyAsItsGzipTwin() throws {
    let entries = toolEntries(manifest())
    let gzipped = try gzip(tar(entries), name: "twin-gz")
    let brotlied = try brotli(tar(entries), name: "twin-br")
    let gzipSha = try XCTUnwrap(OfficialArchive.sha256(file: gzipped))
    let brotliSha = try XCTUnwrap(OfficialArchive.sha256(file: brotlied))
    let fromBrotli = try publish(brotlied, entry: entry(sha: brotliSha)).get()
    XCTAssertEqual(try String(contentsOfFile: "\(fromBrotli.copy.path)/bin/tool", encoding: .utf8), "#!/bin/sh\necho hi\n")
    XCTAssertTrue(FileManager.default.isExecutableFile(atPath: "\(fromBrotli.copy.path)/bin/tool"))
    XCTAssertTrue(store.remove("tool"))
    let fromGzip = try publish(gzipped, entry: entry(sha: gzipSha)).get()
    XCTAssertEqual(fromBrotli.copy.payloadDigest, fromGzip.copy.payloadDigest, "the payload digest is of the files, whatever the archive was packed with")
  }

  func testADamagedOrPaddedBrotliArchiveIsRefused() throws {
    let packed = try brotli(tar(toolEntries(manifest())), name: "whole")
    let bytes = try Data(contentsOf: URL(fileURLWithPath: packed))
    let cut = "\(root)/cut.tar.br"
    try bytes.prefix(bytes.count / 2).write(to: URL(fileURLWithPath: cut))
    let padded = "\(root)/padded.tar.br"
    try (bytes + Data("trailing".utf8)).write(to: URL(fileURLWithPath: padded))
    let garbage = "\(root)/garbage.tar.br"
    try Data((0..<4096).map { UInt8(truncatingIfNeeded: $0 &* 37) }).write(to: URL(fileURLWithPath: garbage))
    for path in [cut, padded, garbage] {
      let sha = try XCTUnwrap(OfficialArchive.sha256(file: path))
      guard case .failure(let failure) = publish(path, entry: entry(sha: sha)) else { return XCTFail("\(path) was accepted") }
      XCTAssertEqual(failure.code, "verify", path)
    }
  }

  func testUnpackingWorksOutThePayloadDigestTheCopyIsCheckedAgainst() throws {
    let archive = try pluginArchive(manifest())
    let held = try XCTUnwrap(OfficialArchive.snapshot(archive, in: root))
    defer { held.close() }
    let stage = try XCTUnwrap(store.makeScratch("tool", prefix: ".stage-"))
    let folder = open(stage, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    defer { close(folder) }
    let unpacked = OfficialArchive.unpackWithDigest(held.fd, top: "tool", into: folder, scratch: root)
    XCTAssertNil(unpacked.problem)
    XCTAssertEqual(unpacked.payloadDigest, OfficialArchive.payloadDigest(archive: held.fd, top: "tool", scratch: root))
    XCTAssertEqual(unpacked.payloadDigest, PluginPrograms.payloadDigest(stage, keepingCaches: true, skippingReserved: false))
  }

  func testAFreshCheckStillHashesTheDownloadAndTheCopyWhenItsPayloadDigestIsKnown() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    XCTAssertNotNil(store.copy("tool", sha: sha, fresh: true))
    let kept = store.archivePath("tool", sha)
    XCTAssertEqual(chmod(kept, 0o644), 0)
    let original = try Data(contentsOf: URL(fileURLWithPath: kept))
    try (original + Data([0])).write(to: URL(fileURLWithPath: kept))
    XCTAssertNil(store.copy("tool", sha: sha, fresh: true), "a download that no longer has its SHA-256 vouches for nothing, even with its digest known")
    try original.write(to: URL(fileURLWithPath: kept))
    XCTAssertEqual(chmod(kept, 0o444), 0)
    XCTAssertNotNil(store.copy("tool", sha: sha, fresh: true))
    try tamper("\(made.copy.path)/bin/tool", "#!/bin/sh\necho swapped\n")
    XCTAssertEqual(chmod("\(made.copy.path)/bin/tool", 0o555), 0)
    XCTAssertEqual(chmod("\(made.copy.path)/bin", 0o555), 0)
    XCTAssertNil(store.copy("tool", sha: sha, fresh: true), "an edit inside the copy is still caught")
  }

  func testAKnownPayloadDigestCountsOnlyForThePluginItWasWorkedOutFor() throws {
    let archive = try pluginArchive(manifest())
    let sha = try XCTUnwrap(OfficialArchive.sha256(file: archive))
    let made = try publish(archive, entry: entry(sha: sha)).get()
    let kept = store.archivePath("tool", sha)
    XCTAssertNotNil(OfficialVerification.shared.digest(archive: kept, sha: sha, copy: made.copy.path, top: "tool", scratch: root, fresh: true))
    XCTAssertNil(OfficialVerification.shared.digest(archive: kept, sha: sha, copy: made.copy.path, top: "another", scratch: root, fresh: true), "the same download under another name has no payload of its own")
  }

  func testATarChangedBetweenWritingAndReadingIsRefused() throws {
    let raw = tar(toolEntries(manifest()))
    let tarFile = try XCTUnwrap(OfficialArchive.anonymousFile(in: root))
    defer { close(tarFile) }
    XCTAssertTrue(raw.withUnsafeBytes { OfficialArchive.writeAll(tarFile, $0.baseAddress!, raw.count) })
    let stage = "\(root)/stage-changed"
    XCTAssertEqual(mkdir(stage, 0o700), 0)
    let folder = open(stage, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    defer { close(folder) }
    let wrong = OfficialArchive.Written(bytes: Int64(raw.count), sha: String(repeating: "0", count: 64))
    let changed = OfficialArchive.extract(tar: tarFile, top: "tool", into: folder, limit: OfficialArchive.maxExpanded, written: wrong)
    XCTAssertEqual(changed.problem, "the download changed while it was unpacked")
    XCTAssertNil(changed.payloadDigest)
    let longer = OfficialArchive.Written(bytes: Int64(raw.count) - 512, sha: String(repeating: "0", count: 64))
    let other = "\(root)/stage-longer"
    XCTAssertEqual(mkdir(other, 0o700), 0)
    let otherFolder = open(other, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    defer { close(otherFolder) }
    XCTAssertNotNil(OfficialArchive.extract(tar: tarFile, top: "tool", into: otherFolder, limit: OfficialArchive.maxExpanded, written: longer).problem, "bytes past what was written are refused")
  }
}
