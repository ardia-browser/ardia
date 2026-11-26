import Foundation

extension SyncModule {
  static let vaultPhones = VaultPhoneTrust(store: dataDirectory.map { SecretFile(url: $0.appendingPathComponent("sign-in-approval-phones.json")) as SecretStore } ?? LoginKeychain())

  static func vaultPhoneFingerprint(_ key: String) -> String? { Data(base64Encoded: key).flatMap(VaultPhoneKeys.fingerprint) }

  static func vaultTrustedPhones() -> [[String: String]] { Self.vaultPhones.trusted().map { ["phone": $0.phone, "fingerprint": $0.fingerprint] } }

  static func vaultTrustPhone(_ phone: String, _ key: String) -> Bool { Self.vaultPhones.trust(phone: phone, key: key) }

  static func vaultForgetPhone(_ phone: String) -> Bool { Self.vaultPhones.forget(phone: phone) }

  static func vaultVerifyPhone(_ phone: String, _ message: String, _ signature: String) -> String { Self.vaultPhones.verify(phone: phone, message: message, signature: signature).rawValue }
}
