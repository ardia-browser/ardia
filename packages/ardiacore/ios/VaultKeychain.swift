import Foundation
import LocalAuthentication
import os
import Security

enum VaultKeychain {
  static let service = "Ardia Password Managers"
  private static let groupSuffix = ".passwords"
  private static let loginKeychainCalls = OSAllocatedUnfairLock(initialState: 0)

  private static let entitledGroup: String? = {
    guard let task = SecTaskCreateFromSelf(nil),
      let groups = SecTaskCopyValueForEntitlement(task, "keychain-access-groups" as CFString, nil) as? [String]
    else { return nil }
    return groups.first { $0.hasSuffix(groupSuffix) }
  }()

  static let teamSigned: Bool = {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return false }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return false }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
      let fields = info as? [String: Any]
    else { return false }
    return fields[kSecCodeInfoTeamIdentifier as String] != nil
  }()

  static let place: VaultSecretPlace = VaultSecretPlace.choose(
    background: LaunchConfig.shared.background, hasDataDirectory: VaultSandbox.directory != nil, accessGroup: entitledGroup,
    teamSigned: teamSigned, managersDirectory: VaultCache.managersDirectory)

  static var passwordsGroup: String? {
    if case .dataProtection(let group) = place { return group }
    return nil
  }

  private static let shelf: VaultSecretShelf = {
    switch place {
    case .memory: VaultSecretShelf(NoSecrets())
    case .sandboxFile(let directory):
      VaultSecretShelf(VaultSecretFile(directory: directory, plainImport: directory.deletingLastPathComponent().appendingPathComponent("Password Managers.json")))
    case .developmentFile(let directory): VaultSecretShelf(VaultSecretFile(directory: directory))
    case .dataProtection(let group): VaultSecretShelf(DataProtectionSecrets(group: group))
    case .loginKeychain: VaultSecretShelf(LoginKeychainSecrets())
    }
  }()

  static var protectsItems: Bool { place.trusted }

  static func contains(_ account: String) -> Bool { shelf.contains(account) }

  static func read(_ account: String) -> String? { shelf.read(account) }

  static func lookup(_ account: String) -> VaultSecretLookup { shelf.lookup(account) }

  static func accounts() -> Set<String>? { shelf.accounts() }

  static func readProtected(_ account: String) -> String? { place.trusted ? shelf.read(account) : nil }

  @discardableResult
  static func write(_ account: String, _ secret: String) -> Bool { shelf.write(account, secret) }

  static func delete(_ account: String) { shelf.delete(account) }

  static func forgetValues() { shelf.forgetValues() }

  @discardableResult
  static func writeGuarded(_ account: String, _ secret: String) -> Bool {
    guard case .dataProtection(let group) = place else { return shelf.write(account, secret, keep: false) }
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, nil) else { return false }
    let match = DataProtectionSecrets.query(account, group: group)
    SecItemDelete(match as CFDictionary)
    var add = match
    add[kSecValueData as String] = Data(secret.utf8)
    add[kSecAttrLabel as String] = label(account)
    add[kSecAttrAccessControl as String] = access
    let written = SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    if written { shelf.noteStoredElsewhere(account) }
    return written
  }

  static func readGuarded(_ account: String, context: LAContext?, reason: String) -> String? {
    guard case .dataProtection(let group) = place else { return shelf.read(account, keep: false) }
    guard shelf.contains(account) else { return nil }
    var query = DataProtectionSecrets.query(account, group: group)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    let authentication = context ?? LAContext()
    authentication.localizedReason = reason
    query[kSecUseAuthenticationContext as String] = authentication
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  struct Counts: Equatable {
    var reads = 0
    var readsFromMemory = 0
    var writesSkipped = 0
    var loginKeychainCalls = 0
  }

  static func takeCounts() -> Counts {
    let shelved = shelf.takeCounts()
    let login = loginKeychainCalls.withLock { calls in
      defer { calls = 0 }
      return calls
    }
    return Counts(reads: shelved.backendReads, readsFromMemory: shelved.memoryReads, writesSkipped: shelved.skippedWrites, loginKeychainCalls: login)
  }

  fileprivate static func label(_ account: String) -> String { "Ardia: \(account) session" }

  fileprivate static func noteLoginKeychainCall() { loginKeychainCalls.withLock { $0 += 1 } }
}

private struct NoSecrets: VaultSecretBackend {
  func listAccounts() -> Set<String>? { [] }
  func exists(_ account: String) -> Bool? { false }
  func value(_ account: String) -> String? { nil }
  func store(_ account: String, _ secret: String) -> Bool { false }
  func remove(_ account: String) -> Bool { true }
}

private struct DataProtectionSecrets: VaultSecretBackend {
  let group: String

  static func query(_ account: String?, group: String) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: VaultKeychain.service,
      kSecUseDataProtectionKeychain as String: true, kSecAttrAccessGroup as String: group,
    ]
    if let account { query[kSecAttrAccount as String] = account }
    return query
  }

  private static func quiet(_ query: inout [String: Any]) {
    let context = LAContext()
    context.interactionNotAllowed = true
    query[kSecUseAuthenticationContext as String] = context
  }

  func listAccounts() -> Set<String>? {
    var query = Self.query(nil, group: group)
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    Self.quiet(&query)
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let items = found as? [[String: Any]] else { return nil }
    return Set(items.compactMap { $0[kSecAttrAccount as String] as? String })
  }

  func exists(_ account: String) -> Bool? {
    var query = Self.query(account, group: group)
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    Self.quiet(&query)
    switch SecItemCopyMatching(query as CFDictionary, nil) {
    case errSecSuccess, errSecInteractionNotAllowed: return true
    case errSecItemNotFound: return false
    default: return nil
    }
  }

  func value(_ account: String) -> String? {
    var query = Self.query(account, group: group)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    Self.quiet(&query)
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func store(_ account: String, _ secret: String) -> Bool {
    let match = Self.query(account, group: group)
    let data = Data(secret.utf8)
    let updated = SecItemUpdate(match as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if updated == errSecSuccess { return true }
    guard updated == errSecItemNotFound else { return false }
    var add = match
    add[kSecValueData as String] = data
    add[kSecAttrLabel as String] = VaultKeychain.label(account)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }

  func remove(_ account: String) -> Bool {
    let status = SecItemDelete(Self.query(account, group: group) as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }
}

private struct LoginKeychainSecrets: VaultSecretBackend {
  private static func query(_ account: String?) -> [String: Any] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: VaultKeychain.service]
    if let account { query[kSecAttrAccount as String] = account }
    return query
  }

  func listAccounts() -> Set<String>? {
    VaultKeychain.noteLoginKeychainCall()
    var query = Self.query(nil)
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let items = found as? [[String: Any]] else { return nil }
    return Set(items.compactMap { $0[kSecAttrAccount as String] as? String })
  }

  func exists(_ account: String) -> Bool? {
    VaultKeychain.noteLoginKeychainCall()
    var query = Self.query(account)
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    switch SecItemCopyMatching(query as CFDictionary, nil) {
    case errSecSuccess: return true
    case errSecItemNotFound: return false
    default: return nil
    }
  }

  func value(_ account: String) -> String? {
    VaultKeychain.noteLoginKeychainCall()
    var query = Self.query(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func store(_ account: String, _ secret: String) -> Bool {
    VaultKeychain.noteLoginKeychainCall()
    let match = Self.query(account)
    let data = Data(secret.utf8)
    let updated = SecItemUpdate(match as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if updated == errSecSuccess { return true }
    guard updated == errSecItemNotFound else { return false }
    var add = match
    add[kSecValueData as String] = data
    add[kSecAttrLabel as String] = VaultKeychain.label(account)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    if SecItemAdd(add as CFDictionary, nil) == errSecSuccess { return true }
    add.removeValue(forKey: kSecAttrAccessible as String)
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }

  func remove(_ account: String) -> Bool {
    VaultKeychain.noteLoginKeychainCall()
    let status = SecItemDelete(Self.query(account) as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }
}
