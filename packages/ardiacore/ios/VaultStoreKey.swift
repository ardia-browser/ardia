import CryptoKit
import Foundation
import os
import Security

enum VaultStoreKey {
  private static let syncedService = "Ardia Password Store"
  private static let syncedAccount = "local-store-key"
  private static let seenSyncedChange = OSAllocatedUnfairLock<Date?>(initialState: nil)

  private static var accessGroup: String? { VaultKeychain.passwordsGroup }

  private static var testSyncedFile: URL? {
    guard LaunchConfig.shared.background, VaultSandbox.directory != nil,
      let path = LaunchConfig.shared.testValue("vaultSyncedKey"), !path.isEmpty
    else { return nil }
    return URL(fileURLWithPath: path)
  }

  static var syncs: Bool { accessGroup != nil || testSyncedFile != nil }

  private static let ring = VaultKeyRing(storage: VaultKeyStorage(
    syncs: syncs, readSynced: { readSynced() }, addSynced: { addSynced($0) }, syncedMayHaveChanged: { syncedMayHaveChanged() },
    accounts: { VaultKeychain.accounts() }, lookup: { VaultKeychain.lookup($0) }, write: { VaultKeychain.write($0, $1) },
    folderHasFiles: { VaultCloud.folderHasVaultFiles() }))

  static var cloudReady: Bool { ring.cloudReady }

  static func current(creating: Bool) -> SymmetricKey? { ring.current(creating: creating) }

  static func candidates() -> [SymmetricKey] { ring.candidates() }

  static func refresh() { ring.refresh() }

  private static func syncedMayHaveChanged() -> Bool {
    guard testSyncedFile == nil, let group = accessGroup else { return true }
    var query = syncedQuery(group)
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let fields = found as? [String: Any],
      let changed = fields[kSecAttrModificationDate as String] as? Date, let seen = seenSyncedChange.withLock({ $0 })
    else { return true }
    return changed != seen
  }

  private static func encode(_ key: SymmetricKey) -> String { VaultKeyRing.encode(key) }

  private static func decode(_ text: String?) -> SymmetricKey? { VaultKeyRing.decode(text) }

  private static func readSynced() -> VaultKeyRead {
    if let file = testSyncedFile {
      guard FileManager.default.fileExists(atPath: file.path) else { return .missing }
      guard let text = try? String(contentsOf: file, encoding: .utf8), let key = decode(text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
        return .failed
      }
      return .found(key.withUnsafeBytes { Data($0) })
    }
    guard let group = accessGroup else { return .missing }
    var query = syncedQuery(group)
    query[kSecReturnData as String] = true
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return .missing }
    guard status == errSecSuccess, let fields = item as? [String: Any], let data = fields[kSecValueData as String] as? Data,
      let key = decode(String(data: data, encoding: .utf8))
    else { return .failed }
    let changed = fields[kSecAttrModificationDate as String] as? Date
    seenSyncedChange.withLock { $0 = changed }
    return .found(key.withUnsafeBytes { Data($0) })
  }

  private static func syncedQuery(_ group: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: syncedService, kSecAttrAccount as String: syncedAccount,
      kSecAttrAccessGroup as String: group, kSecUseDataProtectionKeychain as String: true,
      kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
    ]
  }

  private static func addSynced(_ key: SymmetricKey) -> SymmetricKey? {
    if let file = testSyncedFile {
      let handle = open(file.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
      guard handle >= 0 else {
        if case .found(let existing) = readSynced() { return SymmetricKey(data: existing) }
        return nil
      }
      let bytes = Array(encode(key).utf8)
      let written = bytes.withUnsafeBytes { write(handle, $0.baseAddress, $0.count) }
      close(handle)
      return written == bytes.count ? key : nil
    }
    guard let group = accessGroup else { return nil }
    var add = syncedQuery(group)
    add[kSecAttrSynchronizable as String] = true
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    add[kSecAttrLabel as String] = "Ardia password store"
    add[kSecValueData as String] = Data(encode(key).utf8)
    switch SecItemAdd(add as CFDictionary, nil) {
    case errSecSuccess: return key
    case errSecDuplicateItem:
      if case .found(let existing) = readSynced() { return SymmetricKey(data: existing) }
      return nil
    default: return nil
    }
  }
}
