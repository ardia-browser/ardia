import CryptoKit
import Foundation

struct VaultNewPasskey: Sendable {
  var credentialId: UUID
  var key: P256.Signing.PrivateKey
  var rpId: String
  var rpName: String
  var userHandle: Data
  var userName: String
  var displayName: String
  var createdAt: Date

  var rawId: Data { withUnsafeBytes(of: credentialId.uuid) { Data($0) } }
}

protocol VaultPasskeyHolder: VaultProvider {
  func passkeySigner(_ cli: VaultCLI, item: String, credential: Data, rpId: String) async throws -> VaultPasskeySigner?
  func savePasskey(_ cli: VaultCLI, credential: VaultNewPasskey, attachTo item: String?, title: String, url: String) async throws -> String
}
