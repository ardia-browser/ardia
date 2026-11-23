import CryptoKit
import Foundation
import LocalAuthentication
import Testing

final class Presence {}

enum StoreFixture {
  static let legacy = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures/vault-legacy", isDirectory: true)

  static func legacyKey() throws -> SymmetricKey {
    SymmetricKey(data: Data(try String(contentsOf: legacy.appendingPathComponent("store-key.txt"), encoding: .utf8).utf8))
  }

  static func legacyBlob(_ name: String) throws -> Data { try Data(contentsOf: legacy.appendingPathComponent(name)) }

  static func scratch() -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("vault-store-\(UUID().uuidString)", isDirectory: true)
  }

  static func folder(_ directory: URL, keys: [SymmetricKey], sealing: SymmetricKey?) -> VaultSealedFolder {
    VaultSealedFolder(directory: directory, keys: { keys }, sealingKey: { sealing })
  }

  static func mode(_ url: URL) -> Int? {
    ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.posixPermissions] as? NSNumber)?.intValue
  }
}

@Suite("Legacy store files")
struct VaultLegacyStoreTests {
  let root = StoreFixture.scratch()
  let newKey = SymmetricKey(size: .bits256)

  @Test func `a store file an older build wrote opens once and is resealed in the bound format`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let blob = try StoreFixture.legacyBlob("bitwarden.vault")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try blob.write(to: root.appendingPathComponent("bitwarden.vault"))
    let store = StoreFixture.folder(root, keys: [newKey, try StoreFixture.legacyKey()], sealing: newKey)

    let opened = try #require(store.read("bitwarden").plain)
    let snapshot = try #require(try JSONSerialization.jsonObject(with: opened) as? [String: Any])
    #expect((snapshot["passwords"] as? [String: Any])?.isEmpty == false)
    let main = try Data(contentsOf: store.file("bitwarden"))
    #expect(VaultSealed.open(main, keys: [newKey], context: "store/bitwarden").plain == opened)
    #expect(store.isBound("bitwarden"))
    #expect(FileManager.default.fileExists(atPath: store.file("bitwarden", VaultSealedFolder.legacySuffix).path) == false)

    try blob.write(to: store.file("bitwarden"))
    #expect(store.read("bitwarden") == .missing)
  }

  @Test func `a legacy blob anywhere but a store's own main file is refused`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let blob = try StoreFixture.legacyBlob("bitwarden.vault")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let store = StoreFixture.folder(root, keys: [newKey, try StoreFixture.legacyKey()], sealing: newKey)
    try blob.write(to: store.file("1password", ".bak"))
    try blob.write(to: store.file("1password", ".held"))
    #expect(store.read("1password") == .missing)
    #expect(store.heldPlain("1password") == nil)
  }

  @Test func `a legacy file no key opens yet is unreadable and waits untouched for its key`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let blob = try StoreFixture.legacyBlob("bitwarden.vault")
    let noKey = StoreFixture.folder(root.appendingPathComponent("NoKey"), keys: [newKey], sealing: newKey)
    try FileManager.default.createDirectory(at: noKey.directory, withIntermediateDirectories: true)
    try blob.write(to: noKey.file("bitwarden"))
    #expect(noKey.read("bitwarden") == .unreadable)
    #expect(noKey.write("bitwarden", Data("{}".utf8)) == false)
    #expect(try Data(contentsOf: noKey.file("bitwarden")) == blob)
  }

  @Test func `a bound store sets an older build's file aside instead of reading or deleting it`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let oldKey = SymmetricKey(size: .bits256)
    let store = StoreFixture.folder(root, keys: [newKey, oldKey], sealing: newKey)
    #expect(store.write("ardia", Data("bound".utf8)))
    let downgraded = try #require(try AES.GCM.seal(Data("edited on an older build".utf8), using: oldKey).combined)
    try downgraded.write(to: store.file("ardia"))
    try? FileManager.default.removeItem(at: store.file("ardia", ".bak"))
    #expect(store.read("ardia") == .missing)
    #expect(store.write("ardia", Data("next".utf8)))
    let aside = store.asideFiles("ardia")
    #expect(aside.count == 1)
    #expect(try Data(contentsOf: try #require(aside.first)) == downgraded)
    #expect(store.read("ardia").plain == Data("next".utf8))
    for round in 0..<10 {
      try downgraded.write(to: store.file("ardia"))
      _ = store.write("ardia", Data("round \(round)".utf8))
    }
    #expect(store.asideFiles("ardia").count == VaultSealedFolder.mostAside)
    store.delete("ardia")
    #expect(store.asideFiles("ardia").isEmpty)
  }
}

@Suite("Unreadable store files")
struct VaultUnreadableStoreTests {
  @Test func `writes read back, are private and keep the previous copy`() {
    let root = StoreFixture.scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let key = SymmetricKey(size: .bits256)
    let store = StoreFixture.folder(root, keys: [key], sealing: key)
    #expect(store.read("ardia") == .missing)
    #expect(store.write("ardia", Data("one".utf8)))
    #expect(store.read("ardia").plain == Data("one".utf8))
    #expect(StoreFixture.mode(store.file("ardia")) == 0o600)
    #expect(store.write("ardia", Data("two".utf8)))
    #expect(store.read("ardia").plain == Data("two".utf8))
    #expect(FileManager.default.fileExists(atPath: store.file("ardia", ".bak").path))
  }

  @Test func `a damaged store with no backup that opens is unreadable, not missing`() throws {
    let root = StoreFixture.scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let key = SymmetricKey(size: .bits256)
    let store = StoreFixture.folder(root, keys: [key], sealing: key)
    #expect(store.write("ardia", Data("one".utf8)))
    var damaged = try Data(contentsOf: store.file("ardia"))
    damaged[damaged.index(before: damaged.endIndex)] ^= 0xFF
    try damaged.write(to: store.file("ardia"))
    #expect(store.read("ardia") == .unreadable)
    try damaged.write(to: store.file("ardia", ".bak"))
    try FileManager.default.removeItem(at: store.file("ardia"))
    #expect(store.read("ardia") == .unreadable)
  }

  @Test func `a file that exists but can't be read is unreadable, never replaced, and intact later`() {
    let root = StoreFixture.scratch()
    let key = SymmetricKey(size: .bits256)
    let store = StoreFixture.folder(root, keys: [key], sealing: key)
    defer {
      chmod(store.file("ardia").path, 0o600)
      try? FileManager.default.removeItem(at: root)
    }
    #expect(store.write("ardia", Data("two".utf8)))
    chmod(store.file("ardia").path, 0)
    try? FileManager.default.removeItem(at: store.file("ardia", ".bak"))
    #expect(store.read("ardia") == .unreadable)
    #expect(store.write("ardia", Data("three".utf8)) == false)
    chmod(store.file("ardia").path, 0o600)
    #expect(store.read("ardia").plain == Data("two".utf8))
  }

  @Test func `a Mac with another key holds one copy it can't open until the key arrives`() {
    let root = StoreFixture.scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let key = SymmetricKey(size: .bits256)
    let stranger = SymmetricKey(size: .bits256)
    #expect(StoreFixture.folder(root, keys: [key], sealing: key).write("ardia", Data("two".utf8)))
    let other = StoreFixture.folder(root, keys: [stranger], sealing: stranger)
    #expect(other.write("ardia", Data("theirs".utf8)))
    #expect(FileManager.default.fileExists(atPath: other.file("ardia", ".held").path))
    let third = StoreFixture.folder(root, keys: [SymmetricKey(size: .bits256)], sealing: SymmetricKey(size: .bits256))
    #expect(third.write("ardia", Data("again".utf8)) == false)
    let back = StoreFixture.folder(root, keys: [key, stranger], sealing: key)
    #expect(back.heldPlain("ardia") == Data("two".utf8))
  }
}

@Suite("Store key plans")
struct VaultStoreKeyPlanTests {
  struct Case: Sendable, CustomTestStringConvertible {
    let synced: VaultKeyRead
    let local: VaultKeyRead
    let hasCurrent: Bool
    let creating: Bool
    let mayCreateSynced: Bool
    let wanted: VaultStoreKeyPlan
    let why: String
    var testDescription: String { why }
  }

  static let key = Data(repeating: 1, count: 32)

  @Test("Chooses which key seals the stores", arguments: [
    Case(synced: .found(key), local: .found(key), hasCurrent: false, creating: true, mayCreateSynced: true, wanted: .useSynced, why: "the synced key wins"),
    Case(synced: .missing, local: .found(key), hasCurrent: false, creating: true, mayCreateSynced: true, wanted: .useLocal, why: "a local key is used while the synced one is away"),
    Case(synced: .failed, local: .found(key), hasCurrent: false, creating: true, mayCreateSynced: true, wanted: .useLocal, why: "even when the synced read failed"),
    Case(synced: .missing, local: .failed, hasCurrent: false, creating: true, mayCreateSynced: false, wanted: .wait, why: "a local key that couldn't be read is never replaced"),
    Case(synced: .failed, local: .missing, hasCurrent: false, creating: true, mayCreateSynced: true, wanted: .wait, why: "nor is a synced key that couldn't be read"),
    Case(synced: .missing, local: .missing, hasCurrent: true, creating: true, mayCreateSynced: true, wanted: .keepCurrent, why: "a key already in use is kept"),
    Case(synced: .missing, local: .missing, hasCurrent: false, creating: false, mayCreateSynced: true, wanted: .wait, why: "nothing is made unless asked"),
    Case(synced: .missing, local: .missing, hasCurrent: false, creating: true, mayCreateSynced: true, wanted: .createSynced, why: "only a definite not-found makes a synced key"),
    Case(synced: .missing, local: .missing, hasCurrent: false, creating: true, mayCreateSynced: false, wanted: .createLocal, why: "or a local one while iCloud already holds files"),
  ])
  func choose(row: Case) {
    #expect(VaultStoreKeyPlan.choose(synced: row.synced, local: row.local, hasCurrent: row.hasCurrent, creating: row.creating,
                                     mayCreateSynced: row.mayCreateSynced) == row.wanted)
  }
}

@Suite("Owner presence and prompts")
struct VaultPresenceTests {
  @Test func `a check stays recent for 30 seconds with its context and never lends an older one`() {
    let start = ContinuousClock.now
    var window = VaultPresence<Presence>()
    #expect(window.isRecent(at: start) == false)
    let first = Presence()
    let replacedFirst = window.confirm(at: start, context: first)
    #expect(replacedFirst == nil)
    #expect(window.isRecent(at: start + .seconds(29)))
    #expect(window.context(at: start + .seconds(29)) === first)
    #expect(window.isRecent(at: start + .seconds(30)) == false)
    #expect(window.context(at: start + .seconds(30)) == nil)
    #expect(window.isRecent(at: start - .seconds(1)) == false)
    let replaced = window.confirm(at: start + .seconds(40), context: nil)
    #expect(replaced === first)
    #expect(window.isRecent(at: start + .seconds(41)))
    #expect(window.context(at: start + .seconds(41)) == nil)
    let second = Presence()
    _ = window.confirm(at: start + .seconds(50), context: second)
    let cleared = window.clear()
    #expect(cleared === second)
    #expect(window.isRecent(at: start + .seconds(51)) == false)
  }

  @Test("Touch ID results map to an owner decision", arguments: [
    (true, nil as LAError.Code?, VaultOwnerPrompt.Outcome.granted),
    (false, .userFallback, .askWithPassword),
    (false, .biometryLockout, .askWithPassword),
    (false, .userCancel, .denied),
    (false, .authenticationFailed, .denied),
    (false, .biometryDisconnected, .askWithPassword),
    (false, .biometryNotAvailable, .askWithPassword),
    (false, .systemCancel, .denied),
  ])
  func ownerPrompt(granted: Bool, code: LAError.Code?, wanted: VaultOwnerPrompt.Outcome) {
    #expect(VaultOwnerPrompt.afterBiometrics(granted: granted, code: code) == wanted)
  }
}

final class Locked: @unchecked Sendable {
  let lock = NSLock()
}

@Suite("Generated password store")
struct VaultGeneratedStoreTests {
  let root = StoreFixture.scratch()
  let newKey = SymmetricKey(size: .bits256)
  let now = 1_800_000_000_000.0

  static func generatedStore(_ folder: VaultSealedFolder, legacy: URL?, keys: [SymmetricKey], now: Double) -> VaultGeneratedStore {
    let guardian = Locked()
    return VaultGeneratedStore(
      read: { guardian.lock.withLock { folder.read(VaultGeneratedStore.name) } },
      update: { body in guardian.lock.withLock { folder.change(VaultGeneratedStore.name, body) } },
      mergeHeld: { merge in
        guardian.lock.withLock {
          guard let held = folder.heldPlain(VaultGeneratedStore.name), let merged = merge(held, folder.read(VaultGeneratedStore.name)),
            folder.write(VaultGeneratedStore.name, merged)
          else { return false }
          folder.dropHeld(VaultGeneratedStore.name)
          return true
        }
      },
      legacyFile: legacy, legacyKeys: { keys }, now: { now })
  }

  func entry(_ id: String, origin: String = "https://a.test", createdAt: Double? = nil) -> VaultGeneratedEntry {
    VaultGeneratedEntry(id: id, origin: origin, username: "", password: "fixture-" + id, createdAt: createdAt ?? now, submitted: false)
  }

  @Test func `an old generated file moves once its key is here and merges with what was made meanwhile`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let blob = try StoreFixture.legacyBlob("Generated.vault")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let legacy = root.appendingPathComponent("Generated.vault")
    let cache = StoreFixture.folder(root.appendingPathComponent("Cache", isDirectory: true), keys: [newKey, try StoreFixture.legacyKey()], sealing: newKey)

    try blob.write(to: legacy)
    let locked = Self.generatedStore(cache, legacy: legacy, keys: [SymmetricKey(size: .bits256)], now: now)
    #expect(locked.migrateLegacy() == .kept)
    #expect(try Data(contentsOf: legacy) == blob)
    let made = locked.change { file in
      file.entries.append(entry("new", origin: "https://b.test"))
      return true
    }
    #expect(made)
    #expect(FileManager.default.fileExists(atPath: legacy.path))

    let store = Self.generatedStore(cache, legacy: legacy, keys: [newKey, try StoreFixture.legacyKey()], now: now)
    #expect(store.migrateLegacy() == .moved)
    let current = try #require(store.current())
    #expect(Set(current.entries.map(\.id)) == ["legacy-entry", "new"])
    #expect(current.entries.first { $0.id == "legacy-entry" }?.password == "fixture-" + "generated-pw-1")
    #expect(FileManager.default.fileExists(atPath: legacy.path) == false)
    let main = try Data(contentsOf: cache.file(VaultGeneratedStore.name))
    #expect(VaultSealed.open(main, keys: [newKey], context: "store/generated").plain != nil)
    #expect(store.migrateLegacy() == .nothing)

    try blob.write(to: legacy)
    #expect(store.migrateLegacy() == .moved)
    #expect(store.current()?.entries.count == 2)
  }

  @Test func `an old generated file from a newer version is kept, not moved`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let legacy = root.appendingPathComponent("Generated.vault")
    let plain = Data(#"{"version":2,"keepDays":7,"entries":[]}"#.utf8)
    try #require(try AES.GCM.seal(plain, using: newKey).combined).write(to: legacy)
    let cache = StoreFixture.folder(root.appendingPathComponent("Cache", isDirectory: true), keys: [newKey], sealing: newKey)
    let store = Self.generatedStore(cache, legacy: legacy, keys: [newKey], now: now)
    #expect(store.migrateLegacy() == .kept)
    #expect(FileManager.default.fileExists(atPath: legacy.path))
  }

  @Test func `an old generated file stays when the new store can't be written`() throws {
    defer {
      chmod(root.appendingPathComponent("Cache").path, 0o700)
      try? FileManager.default.removeItem(at: root)
    }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let legacy = root.appendingPathComponent("Generated.vault")
    let plain = try JSONEncoder().encode(VaultGeneratedFile(keepDays: VaultGeneratedStore.keepNone, entries: []))
    try #require(try AES.GCM.seal(plain, using: newKey).combined).write(to: legacy)
    let cache = StoreFixture.folder(root.appendingPathComponent("Cache", isDirectory: true), keys: [newKey], sealing: newKey)
    let store = Self.generatedStore(cache, legacy: legacy, keys: [newKey], now: now)
    #expect(cache.write(VaultGeneratedStore.name, try JSONEncoder().encode(VaultGeneratedFile(keepDays: 7, entries: [entry("a")]))))
    chmod(cache.directory.path, 0o500)
    #expect(store.migrateLegacy() == .kept)
    #expect(FileManager.default.fileExists(atPath: legacy.path))
  }

  @Test func `a generated file that can't be read is never replaced`() {
    defer { try? FileManager.default.removeItem(at: root) }
    let blocked = StoreFixture.folder(root.appendingPathComponent("Cache", isDirectory: true), keys: [newKey], sealing: newKey)
    let store = Self.generatedStore(blocked, legacy: nil, keys: [newKey], now: now)
    let first = store.change { file in
      file.entries.append(entry("a"))
      return true
    }
    #expect(first)
    chmod(blocked.file(VaultGeneratedStore.name).path, 0)
    let refused = store.change { file in
      file.entries.append(entry("b"))
      return true
    }
    #expect(refused == false)
    chmod(blocked.file(VaultGeneratedStore.name).path, 0o600)
    #expect(store.current()?.entries.map(\.id) == ["a"])
  }

  @Test func `a file a newer Ardia wrote is never rewritten`() {
    defer { try? FileManager.default.removeItem(at: root) }
    let folder = StoreFixture.folder(root.appendingPathComponent("Cache", isDirectory: true), keys: [newKey], sealing: newKey)
    let newer = Self.generatedStore(folder, legacy: nil, keys: [newKey], now: now)
    #expect(folder.write(VaultGeneratedStore.name, Data(#"{"version":2,"keepDays":7,"entries":[],"future":true}"#.utf8)))
    let changed = newer.change { _ in true }
    #expect(changed == false)
    #expect(folder.read(VaultGeneratedStore.name).plain.map { String(decoding: $0, as: UTF8.self).contains("future") } == true)
  }

  @Test func `an expired password is purged on the next pass`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let folder = StoreFixture.folder(root.appendingPathComponent("Cache", isDirectory: true), keys: [newKey], sealing: newKey)
    let expiring = Self.generatedStore(folder, legacy: nil, keys: [newKey], now: now)
    let stale = try JSONEncoder().encode(VaultGeneratedFile(keepDays: 7, entries: [entry("old", createdAt: now - 8 * 86_400_000)]))
    #expect(folder.write(VaultGeneratedStore.name, stale))
    let changed = expiring.change { _ in false }
    #expect(changed)
    #expect(expiring.current()?.entries.isEmpty == true)
  }
}

final class Gate: @unchecked Sendable {
  var open = true
  var reads = 0
}

@Suite("Password export")
struct VaultExportTests {
  @Test func `an export reads every login while the vault stays open`() async {
    let gate = Gate()
    let rows = await VaultExportFile.rows(["a", "b", "c"], stillOpen: { gate.open }) { item in
      gate.reads += 1
      return [item]
    }
    #expect(rows == [["a"], ["b"], ["c"]])
    #expect(gate.reads == 3)
  }

  @Test func `a lock mid-export throws the rows away and stops reading at once`() async {
    let locking = Gate()
    let stopped = await VaultExportFile.rows(["a", "b", "c", "d"], stillOpen: { locking.open }) { item in
      locking.reads += 1
      if item == "b" { locking.open = false }
      return [item]
    }
    #expect(stopped == nil)
    #expect(locking.reads == 2)
  }

  @Test func `a lock after the last read still writes nothing`() async {
    let late = Gate()
    let lockedAtEnd = await VaultExportFile.rows(["a"], stillOpen: { defer { late.reads += 1 }; return late.reads == 0 }) { [$0] }
    #expect(lockedAtEnd == nil)
  }

  @Test func `fields with commas, quotes and breaks are quoted`() {
    #expect(VaultExportFile.csv([["a,b", "say \"hi\"", "line\nbreak"]]) == "\"a,b\",\"say \"\"hi\"\"\",\"line\nbreak\"\r\n")
  }

  @Test func `an export replaces the chosen file with a private one and leaves nothing staged`() throws {
    let root = StoreFixture.scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let target = root.appendingPathComponent("Passwords.csv")
    try Data("old".utf8).write(to: target)
    chmod(target.path, 0o644)
    #expect(VaultExportFile.write("name\r\n", to: target))
    #expect(StoreFixture.mode(target) == 0o600)
    #expect(try String(contentsOf: target, encoding: .utf8) == "name\r\n")
    #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix(".") }.isEmpty)
  }

  @Test func `a destination that can't be written fails and leaves no partial file`() {
    let root = StoreFixture.scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let missing = root.appendingPathComponent("Gone", isDirectory: true).appendingPathComponent("Passwords.csv")
    #expect(VaultExportFile.write("x", to: missing) == false)
    #expect(FileManager.default.fileExists(atPath: missing.path) == false)
  }
}

final class FakeKeychain: @unchecked Sendable {
  var synced: SymmetricKey?
  var items: [String: String] = [:]
  var failing: Set<String> = []
  var failingPrefix: String?
  var accountsFail = false
  var writes = 0
  var hasFiles = false
  var folderScans = 0
  var syncedFails = false
  var syncedReadsBeforeFailing: Int?

  func readSynced() -> VaultKeyRead {
    if let left = syncedReadsBeforeFailing {
      guard left > 0 else { return .failed }
      syncedReadsBeforeFailing = left - 1
    }
    if syncedFails { return .failed }
    return synced.map { .found($0.withUnsafeBytes { Data($0) }) } ?? .missing
  }

  func storage() -> VaultKeyStorage {
    VaultKeyStorage(
      syncs: true,
      readSynced: { self.readSynced() },
      addSynced: { key in
        if let existing = self.synced { return existing }
        self.synced = key
        return key
      },
      syncedMayHaveChanged: { true },
      accounts: { self.accountsFail ? nil : Set(self.items.keys) },
      lookup: { account in
        if self.fails(account) { return .failed }
        return self.items[account].map { .found($0) } ?? .missing
      },
      write: { account, value in
        guard self.fails(account) == false else { return false }
        self.writes += 1
        self.items[account] = value
        return true
      },
      folderHasFiles: {
        self.folderScans += 1
        return self.hasFiles
      })
  }

  func fails(_ account: String) -> Bool {
    failing.contains(account) || failingPrefix.map { account.hasPrefix($0) } == true
  }

  var notedKeys: [String] { items.keys.filter { $0.hasPrefix(VaultKeyStorage.keyAccountPrefix) } }
}

@Suite("Store key ring")
struct VaultKeyRingTests {
  let plain = Data("passkeys and codes".utf8)

  @Test func `after a relaunch the key iCloud Keychain kept is used and the losing key still opens`() throws {
    let keychain = FakeKeychain()
    let made = try #require(VaultKeyRing(storage: keychain.storage()).current(creating: true))
    #expect(keychain.synced != nil)
    let sealed = try #require(VaultSealed.seal(plain, with: made, context: "store/ardia"))
    #expect(keychain.items[VaultKeyStorage.account(for: made)] != nil)

    keychain.synced = SymmetricKey(size: .bits256)
    let relaunched = VaultKeyRing(storage: keychain.storage())
    let winner = try #require(relaunched.current(creating: true))
    #expect(VaultKeyRing.same(winner, keychain.synced))
    #expect(VaultSealed.open(sealed, keys: relaunched.candidates(), context: "store/ardia").plain == plain)

    let running = VaultKeyRing(storage: keychain.storage())
    _ = running.current(creating: false)
    keychain.synced = SymmetricKey(size: .bits256)
    running.refresh()
    #expect(VaultSealed.open(sealed, keys: running.candidates(), context: "store/ardia").plain == plain)
  }

  @Test func `a replacement synced key is adopted from the read that saw it, and the old key stays until it is`() throws {
    let keychain = FakeKeychain()
    let ring = VaultKeyRing(storage: keychain.storage())
    let first = try #require(ring.current(creating: true))
    let replacement = SymmetricKey(size: .bits256)
    keychain.synced = replacement
    keychain.syncedReadsBeforeFailing = 1
    ring.refresh()
    #expect(ring.cloudReady)
    #expect(VaultKeyRing.same(replacement, ring.current(creating: false)))

    keychain.syncedReadsBeforeFailing = nil
    keychain.failingPrefix = VaultKeyStorage.keyAccountPrefix
    keychain.synced = SymmetricKey(size: .bits256)
    ring.refresh()
    #expect(VaultKeyRing.same(replacement, ring.current(creating: false)))
    #expect(VaultKeyRing.same(first, ring.current(creating: false)) == false)
  }

  @Test func `a key that can't be noted locally is never made, sealed with, or adopted`() {
    let blocked = FakeKeychain()
    blocked.failingPrefix = VaultKeyStorage.keyAccountPrefix
    #expect(VaultKeyRing(storage: blocked.storage()).current(creating: true) == nil)
    #expect(blocked.synced == nil)
    blocked.synced = SymmetricKey(size: .bits256)
    #expect(VaultKeyRing(storage: blocked.storage()).current(creating: true) == nil)
  }

  @Test func `a new Mac with files in iCloud seals with a local key until the synced one arrives`() throws {
    let local = FakeKeychain()
    local.hasFiles = true
    let localKey = try #require(VaultKeyRing(storage: local.storage()).current(creating: true))
    #expect(local.synced == nil)
    #expect(local.items[VaultKeyStorage.localAccount] != nil)
    let localSealed = try #require(VaultSealed.seal(plain, with: localKey, context: "store/ardia"))
    local.synced = SymmetricKey(size: .bits256)
    let arrived = VaultKeyRing(storage: local.storage())
    #expect(arrived.cloudReady)
    #expect(VaultSealed.open(localSealed, keys: arrived.candidates(), context: "store/ardia").plain == plain)
    local.syncedFails = true
    arrived.refresh()
    #expect(arrived.cloudReady)
  }

  @Test func `no key is made while this Mac's key list can't be read, and one is once it reads`() throws {
    let flaky = FakeKeychain()
    flaky.accountsFail = true
    let recovering = VaultKeyRing(storage: flaky.storage())
    #expect(recovering.current(creating: true) == nil)
    #expect(flaky.writes == 0)
    flaky.accountsFail = false
    let made = try #require(recovering.current(creating: true))
    #expect(flaky.notedKeys == [VaultKeyStorage.account(for: made)])
  }

  @Test func `after a key swap the store still opens and is resealed with the kept key`() throws {
    let root = StoreFixture.scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let swapped = FakeKeychain()
    let before = VaultKeyRing(storage: swapped.storage())
    let lost = try #require(before.current(creating: true))
    let lostFolder = VaultSealedFolder(directory: root, keys: { before.candidates() }, sealingKey: { before.current(creating: true) })
    #expect(lostFolder.write("ardia", plain))
    swapped.synced = SymmetricKey(size: .bits256)
    let kept = try #require(swapped.synced)
    let after = VaultKeyRing(storage: swapped.storage())
    let reopened = VaultSealedFolder(directory: root, keys: { after.candidates() }, sealingKey: { after.current(creating: true) })
    #expect(reopened.read("ardia").plain == plain)
    let resealed = try Data(contentsOf: reopened.file("ardia"))
    #expect(VaultSealed.open(resealed, keys: [kept], context: "store/ardia").plain == plain)
    #expect(VaultSealed.open(resealed, keys: [lost], context: "store/ardia").plain == nil)
  }

  @Test func `a key item that reads as missing once never drops the other keys`() throws {
    let keychain = FakeKeychain()
    let first = try #require(VaultKeyRing(storage: keychain.storage()).current(creating: true))
    let sealedWithFirst = try #require(VaultSealed.seal(plain, with: first, context: "store/ardia"))
    keychain.synced = SymmetricKey(size: .bits256)
    keychain.failing = [VaultKeyStorage.account(for: first)]
    let blinded = VaultKeyRing(storage: keychain.storage())
    #expect(blinded.current(creating: true) != nil)
    keychain.failing = []
    let relaunched = VaultKeyRing(storage: keychain.storage())
    #expect(VaultSealed.open(sealedWithFirst, keys: relaunched.candidates(), context: "store/ardia").plain == plain)
  }

  @Test func `two apps adopting different keys on one keychain both keep every key`() throws {
    let keychain = FakeKeychain()
    keychain.hasFiles = true
    let one = VaultKeyRing(storage: keychain.storage())
    let other = VaultKeyRing(storage: keychain.storage())
    _ = one.candidates()
    _ = other.candidates()
    keychain.items[VaultKeyStorage.localAccount] = VaultKeyRing.encode(SymmetricKey(size: .bits256))
    let firstKey = try #require(one.current(creating: true))
    keychain.items[VaultKeyStorage.localAccount] = VaultKeyRing.encode(SymmetricKey(size: .bits256))
    let secondKey = try #require(other.current(creating: true))
    #expect(VaultKeyRing.same(firstKey, secondKey) == false)
    let relaunched = VaultKeyRing(storage: keychain.storage()).candidates()
    #expect(relaunched.contains { VaultKeyRing.same($0, firstKey) })
    #expect(relaunched.contains { VaultKeyRing.same($0, secondKey) })
  }

  @Test func `keys in the old comma list still open and the list is never rewritten`() throws {
    let keychain = FakeKeychain()
    let retired = [SymmetricKey(size: .bits256), SymmetricKey(size: .bits256)]
    let legacyList = retired.map(VaultKeyRing.encode).joined(separator: ",")
    keychain.items[VaultKeyStorage.legacyKnownAccount] = legacyList
    let sealed = try #require(VaultSealed.seal(plain, with: retired[1], context: "store/ardia"))
    let ring = VaultKeyRing(storage: keychain.storage())
    _ = try #require(ring.current(creating: true))
    #expect(VaultSealed.open(sealed, keys: ring.candidates(), context: "store/ardia").plain == plain)
    #expect(keychain.items[VaultKeyStorage.legacyKnownAccount] == legacyList)
  }

  @Test func `an iCloud account switch that removes the synced key stops cloud sealing and keeps the old key`() throws {
    let keychain = FakeKeychain()
    let ring = VaultKeyRing(storage: keychain.storage())
    let first = try #require(ring.current(creating: true))
    #expect(ring.cloudReady)
    keychain.synced = nil
    ring.refresh()
    #expect(ring.cloudReady == false)
    #expect(ring.candidates().contains { VaultKeyRing.same($0, first) })
  }

  @Test func `a transient synced read failure keeps the current key`() throws {
    let keychain = FakeKeychain()
    let ring = VaultKeyRing(storage: keychain.storage())
    let first = try #require(ring.current(creating: true))
    keychain.syncedFails = true
    ring.refresh()
    #expect(ring.cloudReady)
    #expect(VaultKeyRing.same(try #require(ring.current(creating: false)), first))
  }

  @Test func `iCloud Drive is only scanned when a synced key would be made`() throws {
    let keychain = FakeKeychain()
    keychain.synced = SymmetricKey(size: .bits256)
    let ring = VaultKeyRing(storage: keychain.storage())
    _ = try #require(ring.current(creating: true))
    for _ in 0..<3 { ring.refresh() }
    #expect(keychain.folderScans == 0)

    let fresh = FakeKeychain()
    _ = try #require(VaultKeyRing(storage: fresh.storage()).current(creating: true))
    #expect(fresh.folderScans == 1)
  }

  @Test func `a key item that can't be read doesn't stop a key from being adopted`() throws {
    let keychain = FakeKeychain()
    keychain.items[VaultKeyStorage.keyAccountPrefix + "0011223344556677"] = "unreadable"
    keychain.failing = [VaultKeyStorage.keyAccountPrefix + "0011223344556677"]
    #expect(VaultKeyRing(storage: keychain.storage()).current(creating: true) != nil)
  }
}

@Suite("Store files from a newer build")
struct VaultNewerFormatTests {
  @Test("Format headers", arguments: [
    ("ARV3", true), ("ARV9", true), ("ARV2", false), ("ARV1", false), ("ARVX", false), ("XYZ3", false),
  ])
  func header(magic: String, newer: Bool) {
    let file = Data(magic.utf8) + Data(repeating: 7, count: 48)
    #expect(VaultSealed.isNewerFormat(file) == newer)
    #expect(VaultSealed.isLegacy(file) == (!newer && magic != "ARV2"))
  }

  @Test func `a newer store file reads as unreadable and is never replaced`() throws {
    let root = StoreFixture.scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let key = SymmetricKey(size: .bits256)
    let store = StoreFixture.folder(root, keys: [key], sealing: key)
    let newer = Data("ARV3".utf8) + Data(repeating: 1, count: 64)
    try newer.write(to: store.file("ardia"))
    #expect(store.read("ardia") == .unreadable)
    #expect(store.write("ardia", Data("fresh".utf8)) == false)
    #expect(try Data(contentsOf: store.file("ardia")) == newer)
    #expect(store.asideFiles("ardia").isEmpty)
  }
}
