import CryptoKit
import Foundation
import XCTest
@testable import ArdiaSyncCore

final class SyncVectorsTests: XCTestCase {
  static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures/sync-vectors", isDirectory: true)
  static let vaultPayloads = ["log-line", "pattern-1019", "pattern-1020", "pattern-1021", "empty"]
  static let writers = ["swift", "kotlin"]

  struct Inputs: Codable {
    var entropies: [String: String]
    var scopes: [String]
    var payloads: [String: String]
    var passwords: [Login]
    var localStates: [LocalState]
    var vaultFiles: [VaultFile]
    var damaged: [DamagedFile]
    var pending: [PendingFile]
  }

  struct Login: Codable, Equatable {
    var origin: String
    var username: String
    var password: String
  }

  struct LocalState: Codable {
    var entropy: String
    var fileId: String
    var payload: String
  }

  struct VaultFile: Codable {
    var entropy: String
    var scope: String
    var payload: String
    var id: String
  }

  struct DamagedFile: Codable {
    var entropy: String
    var scope: String
    var payload: String
    var id: String
  }

  struct PendingFile: Codable {
    var entropy: String
    var scope: String
    var id: String
  }

  struct Expected: Codable, Equatable {
    var wordlistSha256: String
    var chains: [String: Chain]
    var passwords: [SealedLogin]
    var localStates: [SealedLocalState]
    var vault: Inventory
  }

  struct Chain: Codable, Equatable {
    var phrase: String
    var chainTag: String
    var scopeTags: [String: String]
  }

  struct SealedLogin: Codable, Equatable {
    var entropy: String
    var origin: String
    var username: String
    var password: String
    var sealed: String
  }

  struct SealedLocalState: Codable, Equatable {
    var entropy: String
    var fileId: String
    var payload: String
    var sealed: String
  }

  struct Inventory: Codable, Equatable {
    var files: [Entry]
    var damaged: [Entry]
    var pending: [Entry]
  }

  struct Entry: Codable, Equatable {
    var entropy: String
    var scope: String
    var payload: String?
    var id: String
    var path: String
  }

  struct RandomSet: Codable {
    var writer: String
    var entropy: String
    var phrase: String
    var chainTag: String
    var scopeTags: [String: String]
    var files: [SetFile]
    var password: Login
    var sealedPassword: String
    var localState: SealedLocalState
  }

  struct SetFile: Codable, Equatable {
    var scope: String
    var payload: String
    var id: String
    var path: String
  }

  static func hex(_ text: String) -> Data {
    Data(stride(from: 0, to: text.count, by: 2).map { offset in
      let start = text.index(text.startIndex, offsetBy: offset)
      return UInt8(text[start..<text.index(start, offsetBy: 2)], radix: 16)!
    })
  }

  static func hexString(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

  static func inputs() throws -> Inputs {
    try JSONDecoder().decode(Inputs.self, from: Data(contentsOf: root.appendingPathComponent("inputs.json")))
  }

  static func expected() throws -> Expected {
    try JSONDecoder().decode(Expected.self, from: Data(contentsOf: root.appendingPathComponent("expected.json")))
  }

  static func payload(_ inputs: Inputs, _ name: String) -> Data { Data(base64Encoded: inputs.payloads[name]!)! }

  static func keys(_ inputs: Inputs, _ entropy: String) -> SyncKeys { SyncKeys(entropy: hex(inputs.entropies[entropy]!)) }

  static func wordlistDigest() -> String { hexString(Data(SHA256.hash(data: Data(Wordlist.english.joined(separator: "\n").utf8)))) }

  static func vaultPath(_ keys: SyncKeys, scope: String, name: String) -> String {
    "vault/\(keys.chainTag)/\(try! keys.scopeTag(scope))/\(name)"
  }

  static func chains(_ inputs: Inputs) -> [String: Chain] {
    Dictionary(uniqueKeysWithValues: inputs.entropies.map { name, entropy in
      let keys = SyncKeys(entropy: hex(entropy))
      return (name, Chain(
        phrase: RecoveryPhrase.words(for: hex(entropy)).joined(separator: " "),
        chainTag: keys.chainTag,
        scopeTags: Dictionary(uniqueKeysWithValues: inputs.scopes.map { ($0, try! keys.scopeTag($0)) })))
    })
  }

  static func sealedPasswords(_ inputs: Inputs) throws -> [SealedLogin] {
    var passwords: [SealedLogin] = []
    for name in inputs.entropies.keys.sorted() {
      for login in inputs.passwords {
        let sealed = try keys(inputs, name).sealPassword(login.password, origin: login.origin, username: login.username)
        passwords.append(SealedLogin(entropy: name, origin: login.origin, username: login.username, password: login.password, sealed: sealed))
      }
    }
    return passwords
  }

  static func write(_ data: Data, to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url)
  }

  static func tree(_ folder: URL) throws -> [String: Data] {
    var files: [String: Data] = [:]
    guard let names = FileManager.default.enumerator(atPath: folder.path) else { return files }
    for case let name as String in names {
      var isDirectory: ObjCBool = false
      let url = folder.appendingPathComponent(name)
      if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue { files[name] = try Data(contentsOf: url) }
    }
    return files
  }

  static func encode<T: Encodable>(_ value: T, to url: URL) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try (encoder.encode(value) + Data("\n".utf8)).write(to: url)
  }

  static func writeRandomSet(_ inputs: Inputs, writer: String, to folder: URL) throws {
    try? FileManager.default.removeItem(at: folder)
    let entropy = RecoveryPhrase.generateEntropy()
    let keys = SyncKeys(entropy: entropy)
    let vault = SyncVault(folder: folder.appendingPathComponent("vault", isDirectory: true), keys: keys)
    try vault.createChain()
    var files: [SetFile] = []
    for scope in inputs.scopes {
      for name in vaultPayloads {
        let id = try vault.write(scope: scope, payload: payload(inputs, name))
        files.append(SetFile(scope: scope, payload: name, id: id, path: vaultPath(keys, scope: scope, name: "\(id).nns")))
      }
    }
    let login = inputs.passwords[1]
    let local = try keys.seal(payload(inputs, "local-state"), scopeTag: "local", fileId: "state")
    try encode(RandomSet(
      writer: writer,
      entropy: hexString(entropy),
      phrase: RecoveryPhrase.words(for: entropy).joined(separator: " "),
      chainTag: keys.chainTag,
      scopeTags: Dictionary(uniqueKeysWithValues: try inputs.scopes.map { ($0, try keys.scopeTag($0)) }),
      files: files,
      password: login,
      sealedPassword: try keys.sealPassword(login.password, origin: login.origin, username: login.username),
      localState: SealedLocalState(entropy: "random", fileId: "state", payload: "local-state", sealed: local.base64EncodedString())
    ), to: folder.appendingPathComponent("manifest.json"))
  }

  func testWriteVectors() throws {
    guard let target = ProcessInfo.processInfo.environment["ARDIA_SYNC_VECTORS_WRITE"], !target.isEmpty else {
      throw XCTSkip("set ARDIA_SYNC_VECTORS_WRITE to the sync-vectors folder to rewrite swift/; cargo test -p ardia-sync-vectors reproduces expected.json and vault/")
    }
    let root = URL(fileURLWithPath: target, isDirectory: true)
    let inputs = try JSONDecoder().decode(Inputs.self, from: Data(contentsOf: root.appendingPathComponent("inputs.json")))
    try Self.writeRandomSet(inputs, writer: "swift", to: root.appendingPathComponent("swift", isDirectory: true))
  }

  func testDeterministicOutputsMatchTheCommittedVectors() throws {
    let inputs = try Self.inputs()
    let committed = try Self.expected()
    XCTAssertEqual(Self.wordlistDigest(), committed.wordlistSha256)
    XCTAssertEqual(Self.chains(inputs), committed.chains)
    XCTAssertEqual(try Self.sealedPasswords(inputs), committed.passwords)
    let committedTree = try Self.tree(Self.root.appendingPathComponent("vault"))
    let listed = (committed.vault.files + committed.vault.damaged + committed.vault.pending).map { String($0.path.dropFirst("vault/".count)) }
    XCTAssertEqual(listed.sorted(), committedTree.keys.sorted())
    for entry in committed.vault.files + committed.vault.damaged + committed.vault.pending {
      let keys = Self.keys(inputs, entry.entropy)
      let name = entry.payload == nil ? ".\(entry.id).nns.icloud" : "\(entry.id).nns"
      XCTAssertEqual(entry.path, Self.vaultPath(keys, scope: entry.scope, name: name))
    }
  }

  func testRandomNoncesKeepTheFormatAndOpen() throws {
    let inputs = try Self.inputs()
    let keys = Self.keys(inputs, "ordinary")
    for name in Self.vaultPayloads {
      let plain = Self.payload(inputs, name)
      let sealed = try keys.seal(plain, scopeTag: keys.scopeTag("app"), fileId: "f")
      let padded = (4 + plain.count + 1023) / 1024 * 1024
      XCTAssertEqual(sealed.count, 4 + 12 + padded + 16, name)
      XCTAssertEqual(sealed.prefix(4), Data("NNS1".utf8))
      XCTAssertEqual(try keys.open(sealed, scopeTag: keys.scopeTag("app"), fileId: "f"), plain)
      XCTAssertNotEqual(try keys.seal(plain, scopeTag: keys.scopeTag("app"), fileId: "f"), sealed)
    }
    let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("sync-vectors-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: scratch) }
    try Self.writeRandomSet(inputs, writer: "swift", to: scratch)
    try checkRandomSet(scratch, writer: "swift")
  }

  func testPhrasesTagsAndWordlistMatch() throws {
    let inputs = try Self.inputs()
    let expected = try Self.expected()
    XCTAssertEqual(Self.wordlistDigest(), expected.wordlistSha256)
    XCTAssertEqual(Wordlist.english.count, 2048)
    XCTAssertEqual(Set(expected.chains.keys), Set(inputs.entropies.keys))
    for (name, chain) in expected.chains {
      let entropy = Self.hex(inputs.entropies[name]!)
      XCTAssertEqual(RecoveryPhrase.words(for: entropy).joined(separator: " "), chain.phrase)
      XCTAssertEqual(try RecoveryPhrase.entropy(from: chain.phrase), entropy)
      let keys = SyncKeys(entropy: entropy)
      XCTAssertEqual(keys.chainTag, chain.chainTag)
      XCTAssertEqual(Set(chain.scopeTags.keys), Set(inputs.scopes))
      for (scope, tag) in chain.scopeTags { XCTAssertEqual(try keys.scopeTag(scope), tag) }
    }
  }

  func testCommittedSealsOpenToTheirPlaintext() throws {
    let inputs = try Self.inputs()
    let expected = try Self.expected()
    XCTAssertEqual(expected.vault.files.count, inputs.vaultFiles.count)
    for file in expected.vault.files {
      let keys = Self.keys(inputs, file.entropy)
      let sealed = try Data(contentsOf: Self.root.appendingPathComponent(file.path))
      XCTAssertEqual(try keys.open(sealed, scopeTag: keys.scopeTag(file.scope), fileId: file.id), Self.payload(inputs, file.payload!), file.path)
    }
    XCTAssertEqual(expected.localStates.count, inputs.localStates.count)
    for state in expected.localStates {
      let sealed = try XCTUnwrap(Data(base64Encoded: state.sealed))
      XCTAssertEqual(try Self.keys(inputs, state.entropy).open(sealed, scopeTag: "local", fileId: state.fileId), Self.payload(inputs, state.payload))
    }
    XCTAssertEqual(expected.passwords.count, inputs.passwords.count * inputs.entropies.count)
    for login in expected.passwords {
      XCTAssertEqual(try Self.keys(inputs, login.entropy).openPassword(login.sealed, origin: login.origin, username: login.username), login.password)
    }
  }

  func testTheVaultReadsTheExactInventory() throws {
    let inputs = try Self.inputs()
    let expected = try Self.expected()
    for entropy in inputs.entropies.keys.sorted() {
      let keys = Self.keys(inputs, entropy)
      let vault = SyncVault(folder: Self.root.appendingPathComponent("vault", isDirectory: true), keys: keys)
      XCTAssertTrue(vault.chainExists())
      for scope in inputs.scopes {
        let mine = { (entries: [Entry]) in entries.filter { $0.entropy == entropy && $0.scope == scope } }
        let listing = try vault.read(scope: scope, skipping: [])
        XCTAssertEqual(listing.files.map(\.id).sorted(), mine(expected.vault.files).map(\.id).sorted())
        XCTAssertEqual(listing.files.map { $0.payload.base64EncodedString() }.sorted(), mine(expected.vault.files).map { inputs.payloads[$0.payload!]! }.sorted())
        XCTAssertEqual(listing.damaged.map(\.id).sorted(), mine(expected.vault.damaged).map(\.id).sorted())
        XCTAssertEqual(listing.pending.sorted(), mine(expected.vault.pending).map(\.id).sorted())
        XCTAssertEqual(listing.present.sorted(), mine(expected.vault.files + expected.vault.damaged + expected.vault.pending).map(\.id).sorted())
        XCTAssertFalse(listing.timedOut)
      }
    }
    XCTAssertFalse(expected.vault.damaged.isEmpty)
    XCTAssertFalse(expected.vault.pending.isEmpty)
    XCTAssertTrue(expected.vault.files.contains { $0.payload == "empty" })
  }

  func testDamagedTamperedAndWrongContextSealsAreRejected() throws {
    let inputs = try Self.inputs()
    let expected = try Self.expected()
    func rejects(_ body: @autoclosure () throws -> Any, _ message: String) {
      XCTAssertThrowsError(try body(), message) { XCTAssertEqual($0 as? SyncKeys.Failure, .authentication, message) }
    }
    for file in expected.vault.damaged {
      let keys = Self.keys(inputs, file.entropy)
      rejects(try keys.open(try Data(contentsOf: Self.root.appendingPathComponent(file.path)), scopeTag: keys.scopeTag(file.scope), fileId: file.id), file.path)
    }
    for file in expected.vault.pending {
      XCTAssertEqual(try Data(contentsOf: Self.root.appendingPathComponent(file.path)), Data())
    }
    for file in expected.vault.files {
      let keys = Self.keys(inputs, file.entropy)
      let other = Self.keys(inputs, inputs.entropies.keys.first { $0 != file.entropy }!)
      let otherScope = inputs.scopes.first { $0 != file.scope }!
      let sealed = try Data(contentsOf: Self.root.appendingPathComponent(file.path))
      rejects(try keys.open(sealed, scopeTag: keys.scopeTag(otherScope), fileId: file.id), "scope \(file.path)")
      rejects(try keys.open(sealed, scopeTag: keys.scopeTag(file.scope), fileId: "state"), "file id \(file.path)")
      rejects(try other.open(sealed, scopeTag: other.scopeTag(file.scope), fileId: file.id), "chain \(file.path)")
      for index in [4, 15, 16, 40, sealed.count - 1] {
        var tampered = sealed
        tampered[index] ^= 0x80
        rejects(try keys.open(tampered, scopeTag: keys.scopeTag(file.scope), fileId: file.id), "byte \(index) of \(file.path)")
      }
    }
    for state in expected.localStates {
      let keys = Self.keys(inputs, state.entropy)
      let sealed = try XCTUnwrap(Data(base64Encoded: state.sealed))
      rejects(try keys.open(sealed, scopeTag: "local", fileId: "other"), "local state file id")
      rejects(try keys.open(sealed, scopeTag: keys.scopeTag("app"), fileId: state.fileId), "local state scope")
    }
    for login in expected.passwords {
      let keys = Self.keys(inputs, login.entropy)
      rejects(try keys.openPassword(login.sealed, origin: login.origin + "x", username: login.username), "origin")
      rejects(try keys.openPassword(login.sealed, origin: login.origin, username: login.username + "x"), "username")
      var tampered = Data(base64Encoded: login.sealed)!
      tampered[tampered.count - 1] ^= 1
      rejects(try keys.openPassword(tampered.base64EncodedString(), origin: login.origin, username: login.username), "tampered password")
    }
  }

  func testBothSidesRandomSetsOpen() throws {
    for writer in Self.writers {
      try checkRandomSet(Self.root.appendingPathComponent(writer, isDirectory: true), writer: writer)
    }
  }

  private func checkRandomSet(_ folder: URL, writer: String) throws {
    let inputs = try Self.inputs()
    let set = try JSONDecoder().decode(RandomSet.self, from: Data(contentsOf: folder.appendingPathComponent("manifest.json")))
    XCTAssertEqual(set.writer, writer)
    let entropy = Self.hex(set.entropy)
    XCTAssertEqual(entropy.count, 32)
    XCTAssertEqual(RecoveryPhrase.words(for: entropy).joined(separator: " "), set.phrase)
    XCTAssertEqual(try RecoveryPhrase.entropy(from: set.phrase), entropy)
    let keys = SyncKeys(entropy: entropy)
    XCTAssertEqual(keys.chainTag, set.chainTag)
    XCTAssertEqual(Set(set.scopeTags.keys), Set(inputs.scopes))
    for (scope, tag) in set.scopeTags { XCTAssertEqual(try keys.scopeTag(scope), tag) }
    let vault = SyncVault(folder: folder.appendingPathComponent("vault", isDirectory: true), keys: keys)
    for scope in inputs.scopes {
      let mine = set.files.filter { $0.scope == scope }
      XCTAssertEqual(mine.map(\.payload).sorted(), Self.vaultPayloads.sorted())
      let listing = try vault.read(scope: scope, skipping: [])
      XCTAssertEqual(listing.damaged.map(\.id), [])
      XCTAssertEqual(listing.pending, [])
      XCTAssertEqual(listing.files.map(\.id).sorted(), mine.map(\.id).sorted())
      XCTAssertEqual(listing.files.map { $0.payload.base64EncodedString() }.sorted(), mine.map { inputs.payloads[$0.payload]! }.sorted())
      for file in mine {
        XCTAssertEqual(file.path, Self.vaultPath(keys, scope: scope, name: "\(file.id).nns"))
        let sealed = try Data(contentsOf: folder.appendingPathComponent(file.path))
        XCTAssertEqual(sealed.prefix(4), Data("NNS1".utf8))
        XCTAssertEqual(try keys.open(sealed, scopeTag: keys.scopeTag(scope), fileId: file.id), Self.payload(inputs, file.payload))
        XCTAssertThrowsError(try keys.open(sealed, scopeTag: keys.scopeTag(scope), fileId: "state"))
      }
    }
    XCTAssertEqual(Set(try Self.tree(folder.appendingPathComponent("vault")).keys), Set(set.files.map { String($0.path.dropFirst("vault/".count)) }))
    XCTAssertEqual(try keys.openPassword(set.sealedPassword, origin: set.password.origin, username: set.password.username), set.password.password)
    XCTAssertEqual(try keys.sealPassword(set.password.password, origin: set.password.origin, username: set.password.username), set.sealedPassword)
    let local = try XCTUnwrap(Data(base64Encoded: set.localState.sealed))
    XCTAssertEqual(try keys.open(local, scopeTag: "local", fileId: set.localState.fileId), Self.payload(inputs, set.localState.payload))
    XCTAssertThrowsError(try keys.open(local, scopeTag: "local", fileId: "other"))
  }
}
