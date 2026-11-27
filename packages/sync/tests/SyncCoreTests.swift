import Foundation
import XCTest
@testable import ArdiaSyncCore

final class RecoveryPhraseTests: XCTestCase {
  func testReferenceVectors() throws {
    let vectors: [(UInt8, String)] = [
      (0x00, Array(repeating: "abandon", count: 23).joined(separator: " ") + " art"),
      (0x7f, "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"),
      (0x80, "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless"),
      (0xff, Array(repeating: "zoo", count: 23).joined(separator: " ") + " vote"),
    ]
    for (byte, phrase) in vectors {
      let entropy = Data(repeating: byte, count: 32)
      XCTAssertEqual(RecoveryPhrase.words(for: entropy).joined(separator: " "), phrase)
      XCTAssertEqual(try RecoveryPhrase.entropy(from: phrase), entropy)
    }
  }

  func testProblemsNameWhatTheUserTyped() {
    let words = RecoveryPhrase.words(for: Data(repeating: 0x7f, count: 32))
    func problem(_ text: String) -> RecoveryPhrase.Problem? {
      do {
        _ = try RecoveryPhrase.entropy(from: text)
        return nil
      } catch {
        return error as? RecoveryPhrase.Problem
      }
    }
    var typo = words
    typo[5] = "Sausagr"
    XCTAssertEqual(problem("  " + typo.joined(separator: ",  ") + "\n"), .unknownWord("sausagr"))
    var first = words
    first[0] = "zzzz"
    first[9] = "qqqq"
    XCTAssertEqual(problem(first.joined(separator: " ")), .unknownWord("zzzz"))
    XCTAssertEqual(problem(words.dropLast().joined(separator: " ")), .wordCount(23))
    XCTAssertEqual(problem(""), .wordCount(0))
    XCTAssertEqual(problem(Array(repeating: "zoo", count: 24).joined(separator: " ")), .checksum)
    XCTAssertEqual(problem(String(repeating: "abandon ", count: 600)), .wordCount(600))
    XCTAssertEqual(problem(words.map { String($0.prefix(4)) }.joined(separator: " ")), nil)
    var accented = words
    accented[2] = "Café"
    accented[7] = "zzzz"
    XCTAssertEqual(problem(accented.joined(separator: " ")), .unknownWord("café"))
    var long = words
    long[4] = String(repeating: "abandon", count: 600)
    XCTAssertEqual(problem(long.joined(separator: " ")), .unknownWord(long[4]))
  }

  func testValidPhrasesRestoreWhateverSurroundsThem() throws {
    let entropy = Data(repeating: 0x7f, count: 32)
    let phrase = RecoveryPhrase.words(for: entropy).joined(separator: " ")
    XCTAssertEqual(try RecoveryPhrase.entropy(from: phrase + String(repeating: " ", count: 4096)), entropy)
    XCTAssertEqual(try RecoveryPhrase.entropy(from: String(repeating: "\n", count: 10_000) + phrase), entropy)
    XCTAssertEqual(try RecoveryPhrase.entropy(from: phrase + " \u{A7DD}"), entropy)
    XCTAssertEqual(RecoveryPhrase.tokens(in: phrase + " \u{A7DD}").count, 24)
  }
}

final class SyncCryptoTests: XCTestCase {
  let entropy = RecoveryPhrase.generateEntropy()
  lazy var keys = SyncKeys(entropy: entropy)

  func testTamperingIsDetected() throws {
    let sealed = try keys.seal(Data("bookmark".utf8), scopeTag: "s", fileId: "f")
    for index in [4, 10, 16, 40, sealed.count - 1] {
      var bad = sealed
      bad[index] ^= 0x01
      XCTAssertThrowsError(try keys.open(bad, scopeTag: "s", fileId: "f")) { XCTAssertEqual($0 as? SyncKeys.Failure, .authentication) }
    }
    XCTAssertThrowsError(try keys.open(sealed.prefix(sealed.count / 2), scopeTag: "s", fileId: "f"))
    XCTAssertThrowsError(try keys.open(sealed.prefix(10), scopeTag: "s", fileId: "f")) { XCTAssertEqual($0 as? SyncKeys.Failure, .format) }
    XCTAssertThrowsError(try keys.open(Data(), scopeTag: "s", fileId: "f")) { XCTAssertEqual($0 as? SyncKeys.Failure, .format) }
    XCTAssertThrowsError(try keys.open(sealed, scopeTag: "s", fileId: "g")) { XCTAssertEqual($0 as? SyncKeys.Failure, .authentication) }
    XCTAssertThrowsError(try keys.open(sealed, scopeTag: "t", fileId: "f")) { XCTAssertEqual($0 as? SyncKeys.Failure, .authentication) }
  }

  func testWrongPhraseCantOpen() throws {
    let sealed = try keys.seal(Data("bookmark".utf8), scopeTag: "s", fileId: "f")
    let other = SyncKeys(entropy: RecoveryPhrase.generateEntropy())
    XCTAssertThrowsError(try other.open(sealed, scopeTag: "s", fileId: "f")) { XCTAssertEqual($0 as? SyncKeys.Failure, .authentication) }
    XCTAssertNotEqual(other.chainTag, keys.chainTag)
  }

  func testOpenFailuresAreCountedByCodeOnlyWhileSharing() throws {
    defer { SyncKeys.consentEpoch = { "" } }
    let sealed = try keys.seal(Data("bookmark".utf8), scopeTag: "s", fileId: "f")
    let failThreeTimes = { [keys] in
      _ = try? keys.open(sealed, scopeTag: "s", fileId: "g")
      _ = try? keys.open(sealed, scopeTag: "t", fileId: "f")
      _ = try? keys.open(Data(), scopeTag: "s", fileId: "f")
    }
    SyncKeys.consentEpoch = { "" }
    failThreeTimes()
    XCTAssertEqual(SyncKeys.takeOpenFailures(), [:])
    SyncKeys.consentEpoch = { "period-1" }
    failThreeTimes()
    XCTAssertEqual(try keys.open(sealed, scopeTag: "s", fileId: "f"), Data("bookmark".utf8))
    XCTAssertEqual(SyncKeys.takeOpenFailures(), ["authentication": 2, "format": 1])
    XCTAssertEqual(SyncKeys.takeOpenFailures(), [:])
    failThreeTimes()
    SyncKeys.consentEpoch = { "period-2" }
    XCTAssertEqual(SyncKeys.takeOpenFailures(), [:])
    SyncKeys.consentEpoch = { "" }
    failThreeTimes()
    SyncKeys.consentEpoch = { "period-2" }
    XCTAssertEqual(SyncKeys.takeOpenFailures(), [:])
  }

  func testPasswordsKeepEveryByteButTheOneLeadingMarkSwiftDropped() throws {
    for (password, opened) in [("\u{FEFF}\u{FEFF}secret", "\u{FEFF}secret"), ("\u{FEFF}secret", "secret"), ("se\u{FEFF}cret", "se\u{FEFF}cret"), ("", "")] {
      let sealed = try keys.sealPassword(password, origin: "https://a.example", username: "ada")
      XCTAssertEqual(try keys.openPassword(sealed, origin: "https://a.example", username: "ada"), opened)
      XCTAssertEqual(try LegacySwiftSeal(entropy: entropy).openPassword(sealed, origin: "https://a.example", username: "ada"), opened)
    }
  }

  func testCheckpointsAsLargeAsSwiftWroteStillOpenAndSave() throws {
    let legacy = LegacySwiftSeal(entropy: entropy)
    var payload = Data(count: 64 * 1024 * 1024 + 1)
    payload[0] = 1
    payload[payload.count - 1] = 2
    let tag = try keys.scopeTag("app")
    let fromSwift = try legacy.seal(payload, scopeTag: tag, fileId: "checkpoint")
    XCTAssertEqual(try keys.open(fromSwift, scopeTag: tag, fileId: "checkpoint"), payload)
    let fromRust = try keys.seal(payload, scopeTag: tag, fileId: "checkpoint")
    XCTAssertEqual(try legacy.open(fromRust, scopeTag: tag, fileId: "checkpoint"), payload)
  }

  func testPasswordsOfAnyLengthSwiftSealedStillSealAndOpen() throws {
    let legacy = LegacySwiftSeal(entropy: entropy)
    for length in [65_535, 65_536, 100_000, 4 * 1024 * 1024] {
      let password = String(repeating: "p", count: length)
      let origin = "https://" + String(repeating: "o", count: length / 4) + ".example"
      let fromSwift = try legacy.sealPassword(password, origin: origin, username: "ada")
      XCTAssertEqual(try keys.openPassword(fromSwift, origin: origin, username: "ada"), password, "\(length)")
      XCTAssertEqual(try keys.sealPassword(password, origin: origin, username: "ada"), fromSwift, "\(length)")
    }
  }

  func testAFailedOpenCountsOnlyInThePeriodItStartedAndEndedIn() throws {
    defer { SyncKeys.consentEpoch = { "" } }
    _ = SyncKeys.takeOpenFailures()
    var asked = 0
    SyncKeys.consentEpoch = {
      asked += 1
      return asked == 1 ? "" : "period-1"
    }
    _ = try? keys.open(Data(), scopeTag: "s", fileId: "f")
    XCTAssertEqual(SyncKeys.takeOpenFailures(), [:])
    asked = 0
    SyncKeys.consentEpoch = {
      asked += 1
      return asked == 1 ? "period-1" : "period-2"
    }
    _ = try? keys.open(Data(), scopeTag: "s", fileId: "f")
    XCTAssertEqual(SyncKeys.takeOpenFailures(), [:])
    SyncKeys.consentEpoch = { "period-2" }
    _ = try? keys.open(Data(), scopeTag: "s", fileId: "f")
    XCTAssertEqual(SyncKeys.takeOpenFailures(), ["format": 1])
  }

  func testLongScopesAreTaggedLikeSwiftAndTooLongOnesThrow() throws {
    let legacy = LegacySwiftSeal(entropy: entropy)
    for length in [511, 512, 513, 4096, 64 * 1024 - 1, 64 * 1024] {
      let scope = String(repeating: "é", count: length / 2) + (length % 2 == 1 ? "s" : "")
      XCTAssertEqual(scope.utf8.count, length)
      XCTAssertEqual(try keys.scopeTag(scope), legacy.scopeTag(scope), "\(length)")
    }
    XCTAssertThrowsError(try keys.scopeTag(String(repeating: "s", count: 64 * 1024 + 1))) { XCTAssertEqual($0 as? SyncKeys.Failure, .format) }
  }
}

final class SyncVaultTests: XCTestCase {
  var folder: URL!
  let entropy = RecoveryPhrase.generateEntropy()
  var vault: SyncVault!

  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent("ac-sync-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    vault = SyncVault(folder: folder, keys: SyncKeys(entropy: entropy))
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: folder)
  }

  func testFolderHoldsNoPlaintext() throws {
    let keys = SyncKeys(entropy: Data(repeating: 0, count: 30) + Data([4, 84]))
    XCTAssertEqual(keys.chainTag, "6happ6iw6rqt67wxcfun6lltsi")
    vault = SyncVault(folder: folder, keys: keys)
    try vault.createChain()
    let secrets = ["https://secret-bank.example/login", "Quarterly Plans", "hunter2-password", "alice@example.com"]
    let payload = try JSONSerialization.data(withJSONObject: ["secrets": secrets])
    var expectedPaths: Set<String> = [keys.chainTag]
    for scope in ["p:default", "app"] {
      let id = try vault.write(scope: scope, payload: payload)
      let scopePath = "\(keys.chainTag)/\(try keys.scopeTag(scope))"
      expectedPaths.insert(scopePath)
      expectedPaths.insert("\(scopePath)/\(id).nns")
    }
    let files = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: nil)!.compactMap { $0 as? URL }
    let folderPath = folder.resolvingSymlinksInPath().path + "/"
    let relativePaths = Set(files.map { String($0.resolvingSymlinksInPath().path.dropFirst(folderPath.count)) })
    XCTAssertEqual(relativePaths, expectedPaths)
    for url in files {
      let name = url.deletingPathExtension().lastPathComponent
      XCTAssertTrue(Base32.isTag(name), name)
      for secret in secrets {
        XCTAssertFalse(url.path.dropFirst(folder.path.count).contains(secret))
      }
      guard let data = try? Data(contentsOf: url) else { continue }
      for secret in secrets { XCTAssertNil(data.range(of: Data(secret.utf8)), "\(secret) in \(url.lastPathComponent)") }
    }
  }

  func testDeleteChainLeavesOtherPhrases() throws {
    try vault.createChain()
    try vault.write(scope: "app", payload: Data("mine".utf8))
    let other = SyncVault(folder: folder, keys: SyncKeys(entropy: RecoveryPhrase.generateEntropy()))
    try other.createChain()
    try other.write(scope: "app", payload: Data("theirs".utf8))
    try vault.deleteChain()
    XCTAssertFalse(vault.chainExists())
    XCTAssertEqual(try other.read(scope: "app", skipping: []).files.count, 1)
  }

  func testWriteNeverRecreatesADeletedChain() throws {
    XCTAssertThrowsError(try vault.write(scope: "app", payload: Data("early".utf8))) { XCTAssertTrue($0 is SyncVault.ChainMissing) }
    XCTAssertFalse(vault.chainExists())
    try vault.createChain()
    try vault.write(scope: "app", payload: Data("mine".utf8))
    try vault.write(scope: "p:work", payload: Data("first".utf8))
    try vault.deleteChain()
    for scope in ["app", "p:work", "p:new"] {
      XCTAssertThrowsError(try vault.write(scope: scope, payload: Data("queued".utf8))) { XCTAssertTrue($0 is SyncVault.ChainMissing) }
    }
    XCTAssertFalse(vault.chainExists())
    try vault.createChain()
    try vault.write(scope: "p:new", payload: Data("again".utf8))
    XCTAssertEqual(try vault.read(scope: "p:new", skipping: []).files.map { String(decoding: $0.payload, as: UTF8.self) }, ["again"])
  }

  func testMissingScopeReadsEmptyButUnreadableScopeThrows() throws {
    try vault.createChain()
    XCTAssertTrue(try vault.read(scope: "app", skipping: []).present.isEmpty)
    try vault.write(scope: "app", payload: Data("mine".utf8))
    let scope = try vault.scopeURL("app")
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: scope.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scope.path) }
    XCTAssertThrowsError(try vault.read(scope: "app", skipping: []))
  }

  func testRemoveSkipsFilesAlreadyGoneAndReportsFailures() throws {
    try vault.createChain()
    let id = try vault.write(scope: "app", payload: Data("mine".utf8))
    XCTAssertNoThrow(try vault.remove(scope: "app", ids: ["AAAAAAAAAAAAAAAAAAAAAAAAAA", id]))
    XCTAssertTrue(try vault.read(scope: "app", skipping: []).present.isEmpty)
    let kept = try vault.write(scope: "app", payload: Data("kept".utf8))
    let scope = try vault.scopeURL("app")
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: scope.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scope.path) }
    XCTAssertThrowsError(try vault.remove(scope: "app", ids: [kept])) { error in
      XCTAssertEqual((error as? SyncVault.RemoveFailed)?.ids, [kept])
    }
  }

  func testChainInNewFolderMakesTheFolderAndItsChain() throws {
    let fresh = SyncVault(folder: folder.appendingPathComponent("drive/Ardia Sync", isDirectory: true), keys: SyncKeys(entropy: entropy))
    try fresh.createChainInNewFolder()
    XCTAssertTrue(fresh.chainExists())
    try fresh.write(scope: "app", payload: Data("mine".utf8))
    XCTAssertEqual(try fresh.read(scope: "app", skipping: []).files.count, 1)
  }

  func testChainInNewFolderNeverWritesIntoAFolderThatIsThere() throws {
    let other = SyncVault(folder: folder, keys: SyncKeys(entropy: RecoveryPhrase.generateEntropy()))
    try other.createChain()
    XCTAssertThrowsError(try vault.createChainInNewFolder()) { XCTAssertTrue($0 is SyncVault.FolderExists) }
    XCTAssertFalse(vault.chainExists())
  }

  func testChainInNewFolderLeavesNoFolderWhenTheChainCantBeMade() throws {
    let target = folder.appendingPathComponent("Ardia Sync", isDirectory: true)
    let keys = SyncKeys(entropy: entropy)
    let refusing = ChainHookFileManager(chainTag: keys.chainTag) { _ in throw CocoaError(.fileWriteOutOfSpace) }
    XCTAssertThrowsError(try SyncVault(folder: target, keys: keys, fileManager: refusing).createChainInNewFolder()) { XCTAssertFalse($0 is SyncVault.FolderExists) }
    XCTAssertFalse(FileManager.default.fileExists(atPath: target.path), "a failed create leaves no folder behind to block the next try")
    let retried = SyncVault(folder: target, keys: keys)
    try retried.createChainInNewFolder()
    XCTAssertTrue(retried.chainExists())
  }

  func testChainInNewFolderRefusesAFolderSwappedInWhileTheChainIsMade() throws {
    let target = folder.appendingPathComponent("Ardia Sync", isDirectory: true)
    let keys = SyncKeys(entropy: entropy)
    let other = SyncVault(folder: target, keys: SyncKeys(entropy: RecoveryPhrase.generateEntropy()))
    let swapping = ChainHookFileManager(chainTag: keys.chainTag) { _ in
      try? FileManager.default.removeItem(at: target)
      try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
      try other.createChain()
    }
    XCTAssertThrowsError(try SyncVault(folder: target, keys: keys, fileManager: swapping).createChainInNewFolder()) { XCTAssertTrue($0 is SyncVault.FolderExists) }
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: target.path), [other.chainURL.lastPathComponent], "the folder that arrived holds only its own chain")
  }

  func testChainInNewFolderNeverTouchesAFolderThatIsThereWhateverItHolds() throws {
    let keys = SyncKeys(entropy: entropy)
    let empty = SyncVault(folder: folder.appendingPathComponent("Empty", isDirectory: true), keys: keys)
    try FileManager.default.createDirectory(at: empty.folder, withIntermediateDirectories: false)
    XCTAssertThrowsError(try empty.createChainInNewFolder()) { XCTAssertTrue($0 is SyncVault.FolderExists) }
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: empty.folder.path), [])

    let target = folder.appendingPathComponent("Ardia Sync", isDirectory: true)
    for directory in [".localized", "._notes", ".DS_Store"] {
      try FileManager.default.createDirectory(at: target.appendingPathComponent(directory, isDirectory: true), withIntermediateDirectories: true)
      try Data("kept".utf8).write(to: target.appendingPathComponent(directory).appendingPathComponent("notes.txt"))
    }
    let named = SyncVault(folder: target, keys: keys)
    XCTAssertThrowsError(try named.createChainInNewFolder()) { XCTAssertTrue($0 is SyncVault.FolderExists) }
    XCTAssertFalse(named.chainExists())
    for directory in [".localized", "._notes", ".DS_Store"] {
      XCTAssertEqual(try String(contentsOf: target.appendingPathComponent(directory).appendingPathComponent("notes.txt"), encoding: .utf8), "kept")
    }
  }

  func testChainInNewFolderFallsBackToAnExclusiveMkdirWhereRenameIsUnsupported() throws {
    let keys = SyncKeys(entropy: entropy)
    for code in [ENOTSUP, EINVAL, EXDEV] {
      let fresh = SyncVault(folder: folder.appendingPathComponent("Sync \(code)", isDirectory: true), keys: keys)
      fresh.renameExclusive = { _, _ in code }
      try fresh.createChainInNewFolder()
      XCTAssertTrue(fresh.chainExists())
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: fresh.folder.path), [keys.chainTag])
    }

    let there = SyncVault(folder: folder.appendingPathComponent("There", isDirectory: true), keys: keys)
    try FileManager.default.createDirectory(at: there.folder, withIntermediateDirectories: false)
    there.renameExclusive = { _, _ in ENOTSUP }
    XCTAssertThrowsError(try there.createChainInNewFolder()) { XCTAssertTrue($0 is SyncVault.FolderExists) }
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: there.folder.path), [])

    let target = folder.appendingPathComponent("Failing", isDirectory: true)
    let failing = SyncVault(folder: target, keys: keys)
    failing.renameExclusive = { _, _ in ENOTSUP }
    failing.inPlaceStep = { step in
      if step == "opened" { try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: target.path) }
    }
    XCTAssertThrowsError(try failing.createChainInNewFolder()) { XCTAssertFalse($0 is SyncVault.FolderExists) }
    XCTAssertFalse(FileManager.default.fileExists(atPath: target.path), "the fallback removes only the folder it made")
    let retried = SyncVault(folder: target, keys: keys)
    retried.renameExclusive = { _, _ in ENOTSUP }
    try retried.createChainInNewFolder()
    XCTAssertTrue(retried.chainExists())
  }

  func testFallbackNeverPutsItsChainInAFolderSwappedInAfterItsMkdir() throws {
    let keys = SyncKeys(entropy: entropy)
    let target = folder.appendingPathComponent("Ardia Sync", isDirectory: true)
    let ours = folder.appendingPathComponent("Moved", isDirectory: true)
    for step in ["made", "opened"] {
      try? FileManager.default.removeItem(at: target)
      try? FileManager.default.removeItem(at: ours)
      let vault = SyncVault(folder: target, keys: keys)
      vault.renameExclusive = { _, _ in ENOTSUP }
      vault.inPlaceStep = { now in
        guard now == step else { return }
        try FileManager.default.moveItem(at: target, to: ours)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        try Data("kept".utf8).write(to: target.appendingPathComponent("notes.txt"))
      }
      XCTAssertThrowsError(try vault.createChainInNewFolder(), step) { XCTAssertTrue($0 is SyncVault.FolderExists, step) }
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: target.path), ["notes.txt"], "the folder that arrived gets no chain (\(step))")
    }
  }

  func testFallbackNeverRemovesAChainItDidNotMake() throws {
    let keys = SyncKeys(entropy: entropy)
    let target = folder.appendingPathComponent("Ardia Sync", isDirectory: true)
    let chain = target.appendingPathComponent(keys.chainTag, isDirectory: true)
    let restoredInPlace = SyncVault(folder: target, keys: keys)
    restoredInPlace.renameExclusive = { _, _ in ENOTSUP }
    restoredInPlace.inPlaceStep = { step in
      if step == "opened" { try FileManager.default.createDirectory(at: chain, withIntermediateDirectories: false) }
    }
    XCTAssertThrowsError(try restoredInPlace.createChainInNewFolder()) { XCTAssertTrue($0 is SyncVault.FolderExists) }
    XCTAssertTrue(restoredInPlace.chainExists(), "a chain that appeared before ours is never removed")

    try FileManager.default.removeItem(at: target)
    let ours = folder.appendingPathComponent("Moved", isDirectory: true)
    let swapped = SyncVault(folder: target, keys: keys)
    swapped.renameExclusive = { _, _ in ENOTSUP }
    swapped.inPlaceStep = { step in
      guard step == "opened" else { return }
      try FileManager.default.moveItem(at: target, to: ours)
      try FileManager.default.createDirectory(at: chain, withIntermediateDirectories: true)
    }
    XCTAssertThrowsError(try swapped.createChainInNewFolder()) { XCTAssertTrue($0 is SyncVault.FolderExists) }
    XCTAssertTrue(swapped.chainExists(), "the restored folder and its empty chain survive")
  }
}

final class ChainHookFileManager: FileManager {
  let chainTag: String
  let onChain: (URL) throws -> Void

  init(chainTag: String, onChain: @escaping (URL) throws -> Void) {
    self.chainTag = chainTag
    self.onChain = onChain
    super.init()
  }

  override func createDirectory(at url: URL, withIntermediateDirectories createIntermediates: Bool, attributes: [FileAttributeKey: Any]? = nil) throws {
    if url.lastPathComponent == chainTag { try onChain(url) }
    try super.createDirectory(at: url, withIntermediateDirectories: createIntermediates, attributes: attributes)
  }
}

