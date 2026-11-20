import CryptoKit
import Foundation

enum VaultSealed {
  static let magic = Data("ARV2".utf8)
  static let unboundMagic = Data("ARV1".utf8)
  static let keyIdLength = 8
  static let boxOverhead = 28
  static let shortestSealed = magic.count + keyIdLength + boxOverhead
  private static let keyIdLabel = Data("ardia vault key id".utf8)

  enum Opened: Equatable {
    case opened(Data, current: Bool)
    case unknownKey
    case corrupt

    var plain: Data? {
      if case .opened(let data, _) = self { return data }
      return nil
    }
  }

  static func keyId(_ key: SymmetricKey) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: keyIdLabel, using: key).prefix(keyIdLength))
  }

  static func seal(_ plain: Data, with key: SymmetricKey, context: String) -> Data? {
    let header = magic + keyId(key)
    guard let box = try? AES.GCM.seal(plain, using: key, authenticating: header + Data(context.utf8)), let combined = box.combined else { return nil }
    return header + combined
  }

  static func isWellFormed(_ sealed: Data) -> Bool {
    let headed = sealed.starts(with: magic) || sealed.starts(with: unboundMagic)
    return headed && sealed.count >= shortestSealed
  }

  static func isLegacy(_ sealed: Data) -> Bool { !sealed.starts(with: magic) && !isNewerFormat(sealed) }

  static func isNewerFormat(_ sealed: Data) -> Bool {
    guard sealed.count >= magic.count, sealed.starts(with: magic.prefix(3)) else { return false }
    let version = sealed[sealed.startIndex + 3]
    return version > magic[magic.startIndex + 3] && version <= UInt8(ascii: "9")
  }

  static func open(_ sealed: Data, keys: [SymmetricKey], context: String) -> Opened {
    guard sealed.starts(with: magic) else { return .corrupt }
    return openHeaded(sealed, keys: keys, extra: Data(context.utf8))
  }

  static func openLegacy(_ sealed: Data, keys: [SymmetricKey]) -> Data? {
    if sealed.starts(with: unboundMagic), let plain = openHeaded(sealed, keys: keys, extra: Data()).plain { return plain }
    guard !sealed.starts(with: magic), let box = try? AES.GCM.SealedBox(combined: sealed) else { return nil }
    for key in keys {
      if let plain = try? AES.GCM.open(box, using: key) { return plain }
    }
    return nil
  }

  private static func openHeaded(_ sealed: Data, keys: [SymmetricKey], extra: Data) -> Opened {
    let headerLength = magic.count + keyIdLength
    guard sealed.count > headerLength else { return .corrupt }
    let header = Data(sealed.prefix(headerLength))
    let id = header.suffix(keyIdLength)
    guard let index = keys.firstIndex(where: { keyId($0) == id }) else { return .unknownKey }
    guard let box = try? AES.GCM.SealedBox(combined: Data(sealed.dropFirst(headerLength))),
      let plain = try? AES.GCM.open(box, using: keys[index], authenticating: header + extra)
    else { return .corrupt }
    return .opened(plain, current: index == 0)
  }
}

enum VaultQuitMarker {
  private static let label = Data("ardia unlocked at quit".utf8)

  static func signed(_ marker: [String: Any], key: SymmetricKey) -> String? {
    guard let body = try? JSONSerialization.data(withJSONObject: marker, options: [.sortedKeys]) else { return nil }
    let tag = Data(HMAC<SHA256>.authenticationCode(for: label + body, using: key))
    return body.base64EncodedString() + "." + tag.base64EncodedString()
  }

  static func verified(_ text: String, key: SymmetricKey) -> [String: Any]? {
    let parts = text.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 2, let body = Data(base64Encoded: String(parts[0])), let tag = Data(base64Encoded: String(parts[1])),
      HMAC<SHA256>.isValidAuthenticationCode(tag, authenticating: label + body, using: key)
    else { return nil }
    return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
  }
}
