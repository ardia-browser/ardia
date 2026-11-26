import CryptoKit
import Foundation
import IOKit
import Security

enum VaultKey {
  struct File: Codable {
    var version = 1
    var kind: String
    var wrapped: Data
    var peer: Data
    var salt: Data
    var machine: Data
    var check: Data
  }

  enum Restored {
    case key(SymmetricKey)
    case unreadable
    case retry
  }

  private static let info = Data("ardia-vault-1".utf8)
  private static let tokenObject = "toid"

  static let machine: Data = {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    defer { IOObjectRelease(service) }
    let uuid = (IORegistryEntryCreateCFProperty(service, "IOPlatformUUID" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String) ?? ""
    return Data(SHA256.hash(data: Data("ardia-vault-machine\n\(uuid)".utf8)))
  }()

  static func checksum(_ wrapped: Data) -> Data { Data(SHA256.hash(data: wrapped)) }

  private static func derive(_ secret: Data, salt: Data) -> SymmetricKey {
    HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), salt: salt, info: info, outputByteCount: 32)
  }

  private static func enclaveKey(_ wrapped: Data) -> SecKey? {
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave, tokenObject: wrapped,
    ]
    var error: Unmanaged<CFError>?
    let key = SecKeyCreateWithData(Data() as CFData, attributes as CFDictionary, &error)
    error?.release()
    return key
  }

  private static func agree(_ key: SecKey, peer: Data) -> Data? {
    guard let other = try? P256.KeyAgreement.PublicKey(rawRepresentation: peer) else { return nil }
    let attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPublic]
    var error: Unmanaged<CFError>?
    guard let peerKey = SecKeyCreateWithData(other.x963Representation as CFData, attributes as CFDictionary, &error) else {
      error?.release()
      return nil
    }
    let secret = SecKeyCopyKeyExchangeResult(key, .ecdhKeyExchangeStandard, peerKey, [:] as CFDictionary, &error)
    error?.release()
    return secret as Data?
  }

  static func restore(_ file: File, software: Bool) -> Restored {
    switch file.kind {
    case "software" where software:
      return file.wrapped.count == 32 ? .key(SymmetricKey(data: file.wrapped)) : .unreadable
    case "secureEnclave":
      guard file.machine == machine, file.check == checksum(file.wrapped) else { return .unreadable }
      guard SecureEnclave.isAvailable else { return .retry }
      for _ in 0..<2 {
        if let key = enclaveKey(file.wrapped), let secret = agree(key, peer: file.peer) { return .key(derive(secret, salt: file.salt)) }
      }
      return .unreadable
    default:
      return .unreadable
    }
  }

  static func make(software: Bool) -> (File, SymmetricKey)? {
    var salt = Data(count: 32)
    guard salt.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { return nil }
    if software {
      let made = SymmetricKey(size: .bits256)
      let wrapped = made.withUnsafeBytes { Data($0) }
      return (File(kind: "software", wrapped: wrapped, peer: Data(), salt: salt, machine: machine, check: checksum(wrapped)), made)
    }
    var error: Unmanaged<CFError>?
    guard SecureEnclave.isAvailable, let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error),
      let own = try? SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    else {
      error?.release()
      return nil
    }
    let peer = P256.KeyAgreement.PrivateKey().publicKey.rawRepresentation
    guard let key = enclaveKey(own.dataRepresentation), let secret = agree(key, peer: peer) else { return nil }
    return (File(kind: "secureEnclave", wrapped: own.dataRepresentation, peer: peer, salt: salt, machine: machine, check: checksum(own.dataRepresentation)), derive(secret, salt: salt))
  }
}
