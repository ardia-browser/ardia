import CryptoKit
import Foundation

public enum VaultPhoneKeys {
  public static func fingerprint(of raw: Data) -> String? {
    guard (try? P256.Signing.PublicKey(x963Representation: raw)) != nil else { return nil }
    let hex = SHA256.hash(data: raw).prefix(10).map { String(format: "%02X", $0) }.joined()
    return stride(from: 0, to: hex.count, by: 4).map { start in
      let from = hex.index(hex.startIndex, offsetBy: start)
      return String(hex[from..<hex.index(from, offsetBy: 4)])
    }.joined(separator: " ")
  }

  public static func verify(publicKey raw: Data, message: String, signature: Data) -> Bool {
    guard let key = try? P256.Signing.PublicKey(x963Representation: raw),
          let signature = try? P256.Signing.ECDSASignature(rawRepresentation: signature)
    else { return false }
    return key.isValidSignature(signature, for: Data(message.utf8))
  }
}

#if os(macOS)
public enum VaultPhoneCheck: String, Sendable {
  case ok
  case unenrolled
  case badSignature = "bad_signature"
}

struct VaultPhoneTrust {
  static let service = "Ardia Sign-In Approval Phones"

  let store: SecretStore

  private func key(_ phone: String) -> Data? {
    guard case .found(let raw) = store.read(service: Self.service, account: phone), VaultPhoneKeys.fingerprint(of: raw) != nil else { return nil }
    return raw
  }

  func trusted() -> [(phone: String, fingerprint: String)] {
    (store.accounts(service: Self.service) ?? []).compactMap { phone in
      key(phone).flatMap(VaultPhoneKeys.fingerprint).map { (phone, $0) }
    }
  }

  func trust(phone: String, key encoded: String) -> Bool {
    guard !phone.isEmpty, let raw = Data(base64Encoded: encoded), VaultPhoneKeys.fingerprint(of: raw) != nil else { return false }
    return store.write(service: Self.service, account: phone, label: "Ardia sign-in approval key for a phone", accessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly, data: raw)
  }

  func forget(phone: String) -> Bool {
    store.write(service: Self.service, account: phone, label: "Ardia sign-in approval key for a phone", accessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly, data: Data())
  }

  func verify(phone: String, message: String, signature encoded: String) -> VaultPhoneCheck {
    guard let raw = key(phone) else { return .unenrolled }
    guard let signature = Data(base64Encoded: encoded) else { return .badSignature }
    return VaultPhoneKeys.verify(publicKey: raw, message: message, signature: signature) ? .ok : .badSignature
  }
}
#endif
