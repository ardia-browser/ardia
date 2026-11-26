import ArdiaSyncCore
import CryptoKit
import Foundation
import LocalAuthentication
import Security

public enum VaultPhoneKeyError: Error, Sendable {
  case unavailable
  case cancelled
  case notStored
}

public struct VaultPhoneKey: Sendable {
  public let publicKey: Data
  public let fingerprint: String
  private let blob: Data

  private static let service = "Ardia Sign-In Approval Key"
  private static let account = "phone"

  public static func loadOrCreate() throws -> VaultPhoneKey {
    #if targetEnvironment(simulator)
    if let blob = stored(), let key = try? P256.Signing.PrivateKey(rawRepresentation: blob), let made = VaultPhoneKey(blob: blob, publicKey: key.publicKey.x963Representation) {
      return made
    }
    let key = P256.Signing.PrivateKey()
    guard store(key.rawRepresentation) else { throw VaultPhoneKeyError.notStored }
    guard let made = VaultPhoneKey(blob: key.rawRepresentation, publicKey: key.publicKey.x963Representation) else { throw VaultPhoneKeyError.unavailable }
    return made
    #else
    guard SecureEnclave.isAvailable else { throw VaultPhoneKeyError.unavailable }
    if let blob = stored(), let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob), let made = VaultPhoneKey(blob: blob, publicKey: key.publicKey.x963Representation) {
      return made
    }
    var problem: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &problem) else { throw VaultPhoneKeyError.unavailable }
    let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    guard store(key.dataRepresentation) else { throw VaultPhoneKeyError.notStored }
    guard let made = VaultPhoneKey(blob: key.dataRepresentation, publicKey: key.publicKey.x963Representation) else { throw VaultPhoneKeyError.unavailable }
    return made
    #endif
  }

  private init?(blob: Data, publicKey: Data) {
    guard let fingerprint = VaultPhoneKeys.fingerprint(of: publicKey) else { return nil }
    self.blob = blob
    self.publicKey = publicKey
    self.fingerprint = fingerprint
  }

  public func sign(_ message: String, reason: String) async throws -> String {
    let blob = blob
    return try await Task.detached(priority: .userInitiated) {
      let context = LAContext()
      context.localizedReason = reason
      context.localizedFallbackTitle = "Use Passcode"
      do {
        #if targetEnvironment(simulator)
        guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else { throw VaultPhoneKeyError.cancelled }
        let key = try P256.Signing.PrivateKey(rawRepresentation: blob)
        #else
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
        #endif
        return try key.signature(for: Data(message.utf8)).rawRepresentation.base64EncodedString()
      } catch {
        throw VaultPhoneKeyError.cancelled
      }
    }.value
  }

  private static func query() -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  private static func stored() -> Data? {
    var q = query()
    q[kSecReturnData as String] = true
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
  }

  private static func store(_ blob: Data) -> Bool {
    SecItemDelete(query() as CFDictionary)
    var add = query()
    add[kSecValueData as String] = blob
    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    add[kSecAttrSynchronizable as String] = false
    let status = SecItemAdd(add as CFDictionary, nil)
    if status != errSecSuccess { NSLog("[vault] keeping the sign-in approval key failed: \(status)") }
    return status == errSecSuccess
  }
}
