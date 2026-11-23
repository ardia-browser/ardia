import CryptoKit
import Foundation
import Testing

final class RecordingBackend: VaultSecretBackend, @unchecked Sendable {
  var stored: [String: String]
  var listing: Bool
  var failExists = false
  var failValue = false
  var failRemove = false
  var calls: [String] = []

  init(_ stored: [String: String] = [:], listing: Bool = true) {
    self.stored = stored
    self.listing = listing
  }

  func listAccounts() -> Set<String>? {
    calls.append("list")
    return listing ? Set(stored.keys) : nil
  }

  func exists(_ account: String) -> Bool? {
    calls.append("exists \(account)")
    return failExists ? nil : stored[account] != nil
  }

  func value(_ account: String) -> String? {
    calls.append("value \(account)")
    return failValue ? nil : stored[account]
  }

  func store(_ account: String, _ secret: String) -> Bool {
    calls.append("store \(account)")
    stored[account] = secret
    return true
  }

  func remove(_ account: String) -> Bool {
    calls.append("remove \(account)")
    guard !failRemove else { return false }
    stored[account] = nil
    return true
  }

  var dataCalls: [String] { calls.filter { $0.hasPrefix("value") } }
}

enum SecretFixture {
  static let session = "fixture-" + "session-1"
  static let cacheKey = "fixture-" + "cache-key-1"
  static let oldBuild = "fixture-" + "old-build-1"
  static let marker = "fixture-" + "marker-1"
}

func temporaryRoot() -> URL {
  URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("vault-secrets-\(UUID().uuidString)", isDirectory: true)
}

@Suite("Where secrets are kept")
struct VaultSecretPlaceTests {
  static let managers = URL(fileURLWithPath: "/tmp/data/Password Managers", isDirectory: true)

  struct Case: Sendable, CustomTestStringConvertible {
    let background: Bool
    let hasDataDirectory: Bool
    let accessGroup: String?
    let teamSigned: Bool
    let managersDirectory: URL?
    let wanted: VaultSecretPlace
    let why: String
    var testDescription: String { why }
  }

  @Test("Chooses the place for each build", arguments: [
    Case(background: false, hasDataDirectory: false, accessGroup: "TEAM.app.passwords", teamSigned: true, managersDirectory: managers,
         wanted: .dataProtection(group: "TEAM.app.passwords"), why: "a build with the access group uses only the data-protection keychain"),
    Case(background: false, hasDataDirectory: true, accessGroup: "TEAM.app.passwords", teamSigned: false, managersDirectory: managers,
         wanted: .dataProtection(group: "TEAM.app.passwords"), why: "the access group wins over a scratch data dir"),
    Case(background: false, hasDataDirectory: true, accessGroup: nil, teamSigned: false, managersDirectory: managers,
         wanted: .developmentFile(managers), why: "an ad hoc build keeps its secrets in the data dir, untrusted"),
    Case(background: false, hasDataDirectory: false, accessGroup: nil, teamSigned: false, managersDirectory: managers,
         wanted: .developmentFile(managers), why: "an ad hoc build without a data dir still uses a file"),
    Case(background: false, hasDataDirectory: true, accessGroup: nil, teamSigned: true, managersDirectory: managers,
         wanted: .loginKeychain, why: "a team signature without the access group uses the login keychain, untrusted"),
    Case(background: true, hasDataDirectory: true, accessGroup: "TEAM.app.passwords", teamSigned: true, managersDirectory: managers,
         wanted: .sandboxFile(managers), why: "a hidden instance uses its sandbox file even when entitled"),
    Case(background: true, hasDataDirectory: false, accessGroup: nil, teamSigned: false, managersDirectory: managers,
         wanted: .memory, why: "a hidden instance without a data dir keeps nothing"),
    Case(background: false, hasDataDirectory: false, accessGroup: "", teamSigned: false, managersDirectory: nil,
         wanted: .memory, why: "an empty group and no directory keeps nothing"),
  ])
  func choose(row: Case) {
    let place = VaultSecretPlace.choose(background: row.background, hasDataDirectory: row.hasDataDirectory, accessGroup: row.accessGroup,
                                        teamSigned: row.teamSigned, managersDirectory: row.managersDirectory)
    #expect(place == row.wanted)
  }

  @Test("Trust and login keychain use follow the place", arguments: [
    (VaultSecretPlace.dataProtection(group: "TEAM.app.passwords"), true, false),
    (VaultSecretPlace.developmentFile(managers), false, false),
    (VaultSecretPlace.loginKeychain, false, true),
    (VaultSecretPlace.sandboxFile(managers), true, false),
  ])
  func trust(place: VaultSecretPlace, trusted: Bool, touchesLoginKeychain: Bool) {
    #expect(place.trusted == trusted)
    #expect(place.touchesLoginKeychain == touchesLoginKeychain)
  }
}

@Suite("Secret shelf")
struct VaultSecretShelfTests {
  @Test func `existence comes from one listing and never reads a secret`() {
    let backend = RecordingBackend(["bitwarden": SecretFixture.session, "vault-cache-key": SecretFixture.cacheKey])
    let shelf = VaultSecretShelf(backend)
    #expect(shelf.contains("bitwarden"))
    #expect(shelf.contains("1password") == false)
    #expect(shelf.contains("vault-cache-key"))
    #expect(backend.dataCalls.isEmpty)
    #expect(backend.calls == ["list"])
  }

  @Test func `a failed listing falls back to one remembered check per account`() {
    let unlisted = RecordingBackend(["bitwarden": SecretFixture.session], listing: false)
    let fallback = VaultSecretShelf(unlisted)
    #expect(fallback.contains("bitwarden"))
    #expect(fallback.contains("bitwarden"))
    #expect(unlisted.dataCalls.isEmpty)
    #expect(unlisted.calls.filter { $0 == "exists bitwarden" }.count == 1)
  }

  @Test func `a missing account is never read`() {
    let empty = RecordingBackend()
    #expect(VaultSecretShelf(empty).read("vault-cache-key") == nil)
    #expect(empty.dataCalls.isEmpty)
  }

  @Test func `a secret is read at most once until lock, and guarded reads are never kept`() {
    let backend = RecordingBackend(["vault-cache-key": SecretFixture.cacheKey, "bitwarden": SecretFixture.session])
    let shelf = VaultSecretShelf(backend)
    #expect(shelf.read("vault-cache-key") == SecretFixture.cacheKey)
    #expect(shelf.read("vault-cache-key") == SecretFixture.cacheKey)
    #expect(backend.dataCalls == ["value vault-cache-key"])
    shelf.forgetValues()
    #expect(shelf.read("vault-cache-key") == SecretFixture.cacheKey)
    #expect(backend.dataCalls.count == 2)
    #expect(shelf.read("bitwarden", keep: false) == SecretFixture.session)
    #expect(shelf.read("bitwarden", keep: false) == SecretFixture.session)
    #expect(backend.dataCalls.filter { $0 == "value bitwarden" }.count == 2)
    let counts = shelf.takeCounts()
    #expect(counts.backendReads == 4)
    #expect(counts.memoryReads == 1)
    #expect(counts.listings == 1)
    #expect(shelf.takeCounts() == VaultSecretCounts())
  }

  @Test func `writes skip unchanged values and are read back from memory`() {
    let backend = RecordingBackend()
    let shelf = VaultSecretShelf(backend)
    #expect(shelf.write("vault-retired-keys", "a"))
    #expect(shelf.write("vault-retired-keys", "a"))
    #expect(backend.calls.filter { $0.hasPrefix("store") }.count == 1)
    #expect(shelf.read("vault-retired-keys") == "a")
    #expect(backend.dataCalls.isEmpty)
    #expect(shelf.write("vault-retired-keys", "b"))
    #expect(backend.stored["vault-retired-keys"] == "b")
    shelf.noteStoredElsewhere("bitwarden")
    #expect(shelf.contains("bitwarden"))
    #expect(backend.calls.contains("exists bitwarden") == false)
    #expect(shelf.takeCounts().skippedWrites == 1)
  }

  @Test func `deletes call the backend only for stored items and never read`() {
    let backend = RecordingBackend(["unlocked-at-quit": SecretFixture.marker])
    let shelf = VaultSecretShelf(backend)
    shelf.delete("stays-open-at-quit")
    #expect(backend.calls.contains { $0.hasPrefix("remove") } == false)
    shelf.delete("unlocked-at-quit")
    #expect(backend.stored.isEmpty)
    #expect(shelf.contains("unlocked-at-quit") == false)
    shelf.delete("unlocked-at-quit")
    #expect(backend.calls.filter { $0.hasPrefix("remove") }.count == 1)
    #expect(backend.dataCalls.isEmpty)
  }

  @Test func `a delete that didn't persist still counts the item as stored`() {
    let backend = RecordingBackend(["kept": SecretFixture.marker])
    backend.failRemove = true
    let shelf = VaultSecretShelf(backend)
    shelf.delete("kept")
    #expect(shelf.contains("kept"))
    backend.failRemove = false
    shelf.delete("kept")
    #expect(shelf.contains("kept") == false)
    #expect(backend.stored.isEmpty)
  }

  @Test func `lookups tell missing from failed`() {
    let listed = VaultSecretShelf(RecordingBackend(["here": "v"]))
    #expect(listed.lookup("here") == .found("v"))
    #expect(listed.lookup("gone") == .missing)
    let unlisted = RecordingBackend(["here": "v"], listing: false)
    unlisted.failExists = true
    #expect(VaultSecretShelf(unlisted).lookup("here") == .failed)
    let unreadable = RecordingBackend(["here": "v"])
    unreadable.failValue = true
    #expect(VaultSecretShelf(unreadable).lookup("here") == .failed)
  }
}

@Suite("Sealed secrets file")
struct VaultSecretFileTests {
  let root = temporaryRoot()

  static func mode(_ url: URL) -> Int {
    ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.posixPermissions] as? NSNumber)?.intValue ?? -1
  }

  @Test func `a stored secret reads back sealed, private and never in plain text`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("Password Managers", isDirectory: true)
    let first = VaultSecretFile(directory: directory)
    #expect(first.listAccounts() == [])
    #expect(first.store("bitwarden", SecretFixture.session))
    #expect(VaultSecretFile(directory: directory).value("bitwarden") == SecretFixture.session)
    let sealed = try Data(contentsOf: first.sealedFile)
    #expect(sealed.isEmpty == false)
    #expect(sealed.range(of: Data(SecretFixture.session.utf8)) == nil)
    #expect(Self.mode(first.sealedFile) == 0o600)
    #expect(Self.mode(first.keyFile) == 0o600)
    #expect(Self.mode(directory) == 0o700)
  }

  @Test func `another data dir's key opens nothing and the file is kept aside`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("Password Managers", isDirectory: true)
    let first = VaultSecretFile(directory: directory)
    #expect(first.store("bitwarden", SecretFixture.session))
    let stranger = VaultSecretFile(directory: root.appendingPathComponent("Other", isDirectory: true))
    #expect(stranger.store("x", "y"))
    try FileManager.default.removeItem(at: first.keyFile)
    try FileManager.default.copyItem(at: stranger.keyFile, to: first.keyFile)
    #expect(VaultSecretFile(directory: directory).value("bitwarden") == nil)
    #expect(FileManager.default.fileExists(atPath: first.sealedFile.path + ".unreadable"))
  }

  @Test func `each file set aside after its key is lost is kept`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let lost = root.appendingPathComponent("Lost", isDirectory: true)
    let before = VaultSecretFile(directory: lost)
    #expect(before.store("bitwarden", "fixture-first"))
    try FileManager.default.removeItem(at: before.keyFile)
    #expect(VaultSecretFile(directory: lost).value("bitwarden") == nil)
    #expect(VaultSecretFile(directory: lost).store("bitwarden", "fixture-second"))
    try FileManager.default.removeItem(at: before.keyFile)
    _ = VaultSecretFile(directory: lost).value("bitwarden")
    let asides = try FileManager.default.contentsOfDirectory(atPath: lost.path).filter { $0.hasPrefix(VaultSecretFile.sealedName + ".unreadable") }
    #expect(asides.count == 2)
  }

  @Test func `a key that can't be read makes the secrets unavailable until it reads again`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let locked = root.appendingPathComponent("Locked", isDirectory: true)
    let held = VaultSecretFile(directory: locked)
    #expect(held.store("bitwarden", "fixture-kept"))
    let sealedBefore = try Data(contentsOf: held.sealedFile)
    chmod(held.keyFile.path, 0)
    let blocked = VaultSecretFile(directory: locked)
    #expect(blocked.value("bitwarden") == nil)
    #expect(blocked.listAccounts() == nil)
    #expect(blocked.store("bitwarden", "fixture-other") == false)
    chmod(held.keyFile.path, 0o600)
    #expect(try Data(contentsOf: held.sealedFile) == sealedBefore)
    #expect(VaultSecretFile(directory: locked).value("bitwarden") == "fixture-kept")
  }

  @Test func `an old unbound secrets file opens once and is resealed in the bound format`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let legacyDir = root.appendingPathComponent("Legacy", isDirectory: true)
    try FileManager.default.createDirectory(at: legacyDir, withIntermediateDirectories: true)
    let legacyKey = SymmetricKey(size: .bits256)
    try legacyKey.withUnsafeBytes { Data($0) }.write(to: legacyDir.appendingPathComponent(VaultSecretFile.keyName))
    let legacyPlain = try JSONEncoder().encode(["bitwarden": SecretFixture.oldBuild])
    try #require(try AES.GCM.seal(legacyPlain, using: legacyKey).combined).write(to: legacyDir.appendingPathComponent(VaultSecretFile.sealedName))
    #expect(VaultSecretFile(directory: legacyDir).value("bitwarden") == SecretFixture.oldBuild)
    let resealed = try Data(contentsOf: legacyDir.appendingPathComponent(VaultSecretFile.sealedName))
    #expect(VaultSealed.isLegacy(resealed) == false)
  }

  @Test func `a hidden instance's old plain file is imported, sealed and removed`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let plainDir = root.appendingPathComponent("Plain", isDirectory: true)
    let plainFile = root.appendingPathComponent("Password Managers.json")
    try JSONEncoder().encode(["bitwarden": SecretFixture.oldBuild]).write(to: plainFile)
    #expect(VaultSecretFile(directory: plainDir, plainImport: plainFile).value("bitwarden") == SecretFixture.oldBuild)
    #expect(FileManager.default.fileExists(atPath: plainFile.path) == false)
    #expect(VaultSecretFile(directory: plainDir).value("bitwarden") == SecretFixture.oldBuild)
  }

  @Test func `an imported plain file that couldn't be removed is removed on a later launch, and an unrelated one is left`() throws {
    defer {
      chmod(root.path, 0o700)
      try? FileManager.default.removeItem(at: root)
    }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let plainDir = root.appendingPathComponent("Plain", isDirectory: true)
    try FileManager.default.createDirectory(at: plainDir, withIntermediateDirectories: true)
    let plainFile = root.appendingPathComponent("Password Managers.json")
    try JSONEncoder().encode(["bitwarden": SecretFixture.oldBuild]).write(to: plainFile)
    chmod(root.path, 0o500)
    #expect(VaultSecretFile(directory: plainDir, plainImport: plainFile).value("bitwarden") == SecretFixture.oldBuild)
    #expect(FileManager.default.fileExists(atPath: plainFile.path))
    chmod(root.path, 0o700)
    #expect(VaultSecretFile(directory: plainDir, plainImport: plainFile).value("bitwarden") == SecretFixture.oldBuild)
    #expect(FileManager.default.fileExists(atPath: plainFile.path) == false)
    try JSONEncoder().encode(["bitwarden": "fixture-" + "unrelated"]).write(to: plainFile)
    #expect(VaultSecretFile(directory: plainDir, plainImport: plainFile).value("bitwarden") == SecretFixture.oldBuild)
    #expect(FileManager.default.fileExists(atPath: plainFile.path))
  }

  @Test func `a secrets file from a newer Ardia stays where it is and nothing replaces it`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("Newer", isDirectory: true)
    let first = VaultSecretFile(directory: directory)
    #expect(first.store("bitwarden", SecretFixture.session))
    let newer = Data("ARV3".utf8) + Data(repeating: 7, count: 64)
    try newer.write(to: first.sealedFile)
    let later = VaultSecretFile(directory: directory)
    #expect(later.value("bitwarden") == nil)
    #expect(later.store("bitwarden", "fixture-" + "other") == false)
    #expect(try Data(contentsOf: first.sealedFile) == newer)
  }

  @Test func `an unreadable file that can't be moved aside is never replaced`() throws {
    defer {
      chmod(root.appendingPathComponent("Stuck").path, 0o700)
      try? FileManager.default.removeItem(at: root)
    }
    let directory = root.appendingPathComponent("Stuck", isDirectory: true)
    let first = VaultSecretFile(directory: directory)
    #expect(first.store("bitwarden", SecretFixture.session))
    let sealed = try Data(contentsOf: first.sealedFile)
    try FileManager.default.removeItem(at: first.keyFile)
    chmod(directory.path, 0o500)
    let stuck = VaultSecretFile(directory: directory)
    #expect(stuck.listAccounts() == nil)
    #expect(stuck.store("bitwarden", "fixture-" + "other") == false)
    #expect(try Data(contentsOf: first.sealedFile) == sealed)
  }
}

@Suite("Touch ID context for keychain reads")
struct VaultTouchUnlockScopeTests {
  @Test func `an unlock touch keeps its Touch ID context for the keychain read`() {
    #expect(VaultTouchGrants.isUnlock(VaultTouchGrants.unlock(provider: "bitwarden")))
  }

  @Test("Other scopes never keep the context", arguments: [
    VaultTouchGrants.fill(provider: "bitwarden", item: "a", origin: "https://a.test", tab: "t"), "unlocked",
  ])
  func notUnlock(scope: String) {
    #expect(VaultTouchGrants.isUnlock(scope) == false)
  }
}
