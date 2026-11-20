import CryptoKit
import Foundation

struct VaultKeyStorage: Sendable {
  static let localAccount = "vault-cache-key"
  static let legacyKnownAccount = "vault-retired-keys"
  static let keyAccountPrefix = "vault-key-"

  var syncs: Bool
  var readSynced: @Sendable () -> VaultKeyRead
  var addSynced: @Sendable (SymmetricKey) -> SymmetricKey?
  var syncedMayHaveChanged: @Sendable () -> Bool
  var accounts: @Sendable () -> Set<String>?
  var lookup: @Sendable (String) -> VaultSecretLookup
  var write: @Sendable (String, String) -> Bool
  var folderHasFiles: @Sendable () -> Bool

  static func account(for key: SymmetricKey) -> String {
    keyAccountPrefix + VaultSealed.keyId(key).map { String(format: "%02x", $0) }.joined()
  }
}

final class VaultKeyRing: @unchecked Sendable {
  private let storage: VaultKeyStorage
  private let lock = NSLock()
  private var resolved: SymmetricKey?
  private var resolvedIsSynced = false
  private var known: [SymmetricKey] = []
  private var listed = false
  private var someUnread = false

  init(storage: VaultKeyStorage) { self.storage = storage }

  var cloudReady: Bool {
    _ = current(creating: false)
    return lock.withLock { resolved != nil && resolvedIsSynced }
  }

  func current(creating: Bool) -> SymmetricKey? {
    lock.withLock {
      if resolved == nil { resolve(creating: creating) }
      return resolved
    }
  }

  func candidates() -> [SymmetricKey] {
    _ = current(creating: false)
    return lock.withLock {
      loadKnown()
      return (resolved.map { [$0] } ?? []) + known.filter { !Self.same($0, resolved) }
    }
  }

  func refresh() {
    lock.withLock {
      guard storage.syncs else { return }
      if resolvedIsSynced, resolved != nil {
        guard storage.syncedMayHaveChanged() else { return }
        switch storage.readSynced() {
        case .found(let data) where Self.same(SymmetricKey(data: data), resolved): return
        case .failed: return
        case .found, .missing:
          resolved = nil
          resolvedIsSynced = false
        }
      }
      resolve(creating: false)
    }
  }

  private func resolve(creating: Bool) {
    loadKnown()
    let synced = storage.readSynced()
    let local = Self.key(from: storage.lookup(VaultKeyStorage.localAccount))
    var plan = VaultStoreKeyPlan.choose(synced: synced, local: local, hasCurrent: resolved != nil, creating: creating, mayCreateSynced: storage.syncs)
    if plan == .createSynced, storage.folderHasFiles() { plan = .createLocal }
    switch plan {
    case .useSynced:
      if case .found(let data) = synced { adopt(SymmetricKey(data: data), synced: true) }
    case .useLocal:
      if case .found(let data) = local { adopt(SymmetricKey(data: data), synced: false) }
    case .keepCurrent:
      break
    case .wait:
      if synced == .failed || local == .failed {
        VaultStoreCounts.note(\.keyReadFailed)
        NSLog("[vaults] the store key couldn't be read, so no new one is made")
      }
    case .createSynced, .createLocal:
      let fresh = SymmetricKey(size: .bits256)
      guard remember(fresh) else { return }
      if plan == .createSynced, let shared = storage.addSynced(fresh) {
        adopt(shared, synced: true)
        return
      }
      guard storage.write(VaultKeyStorage.localAccount, Self.encode(fresh)) else { return }
      adopt(fresh, synced: false)
    }
  }

  private func adopt(_ key: SymmetricKey, synced: Bool) {
    guard remember(key) else {
      VaultStoreCounts.note(\.keyNotNoted)
      NSLog("[vaults] the store key couldn't be noted on this Mac, so nothing is sealed with it yet")
      return
    }
    resolved = key
    resolvedIsSynced = synced
  }

  private func remember(_ key: SymmetricKey) -> Bool {
    if known.contains(where: { Self.same($0, key) }) { return true }
    guard listed, storage.write(VaultKeyStorage.account(for: key), Self.encode(key)) else { return false }
    known.append(key)
    return true
  }

  private func loadKnown() {
    guard !listed || someUnread, let accounts = storage.accounts() else { return }
    var texts: [String] = []
    var unread = false
    for account in accounts.sorted() where account.hasPrefix(VaultKeyStorage.keyAccountPrefix) || account == VaultKeyStorage.legacyKnownAccount
      || account == VaultKeyStorage.localAccount
    {
      guard case .found(let text) = storage.lookup(account) else {
        unread = true
        continue
      }
      if account == VaultKeyStorage.legacyKnownAccount {
        texts += text.split(separator: ",").map(String.init)
      } else if let key = Self.decode(text), account == VaultKeyStorage.localAccount || VaultKeyStorage.account(for: key) == account {
        texts.append(text)
      }
    }
    for text in texts {
      if let key = Self.decode(text), !known.contains(where: { Self.same($0, key) }) { known.append(key) }
    }
    listed = true
    someUnread = unread
  }

  static func key(from lookup: VaultSecretLookup) -> VaultKeyRead {
    switch lookup {
    case .missing: return .missing
    case .failed: return .failed
    case .found(let text):
      guard let key = decode(text) else { return .failed }
      return .found(key.withUnsafeBytes { Data($0) })
    }
  }

  static func same(_ key: SymmetricKey, _ other: SymmetricKey?) -> Bool {
    guard let other else { return false }
    return key.withUnsafeBytes { mine in other.withUnsafeBytes { theirs in mine.elementsEqual(theirs) } }
  }

  static func encode(_ key: SymmetricKey) -> String { key.withUnsafeBytes { Data($0).base64EncodedString() } }

  static func decode(_ text: String?) -> SymmetricKey? {
    guard let text, let data = Data(base64Encoded: text), data.count == 32 else { return nil }
    return SymmetricKey(data: data)
  }
}
