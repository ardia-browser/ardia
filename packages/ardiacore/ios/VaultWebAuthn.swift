import CryptoKit
import Foundation

enum VaultCBOR {
  indirect enum Value: Equatable {
    case int(Int)
    case bytes(Data)
    case text(String)
    case map([(Value, Value)])

    static func == (lhs: Value, rhs: Value) -> Bool { VaultCBOR.encode(lhs) == VaultCBOR.encode(rhs) }
  }

  static func encode(_ value: Value) -> Data {
    var out = Data()
    write(value, into: &out)
    return out
  }

  private static func write(_ value: Value, into out: inout Data) {
    switch value {
    case .int(let number):
      if number >= 0 { head(0, UInt64(number), into: &out) } else { head(1, UInt64(-1 - number), into: &out) }
    case .bytes(let data):
      head(2, UInt64(data.count), into: &out)
      out.append(data)
    case .text(let text):
      let data = Data(text.utf8)
      head(3, UInt64(data.count), into: &out)
      out.append(data)
    case .map(let pairs):
      let encoded = pairs.map { (key: encode($0.0), value: encode($0.1)) }.sorted { canonicallyBefore($0.key, $1.key) }
      head(5, UInt64(encoded.count), into: &out)
      for pair in encoded {
        out.append(pair.key)
        out.append(pair.value)
      }
    }
  }

  private static func canonicallyBefore(_ a: Data, _ b: Data) -> Bool {
    if a.count != b.count { return a.count < b.count }
    return a.lexicographicallyPrecedes(b)
  }

  private static func head(_ major: UInt8, _ value: UInt64, into out: inout Data) {
    let type = major << 5
    switch value {
    case ..<24: out.append(type | UInt8(value))
    case ...0xFF: out.append(contentsOf: [type | 24, UInt8(value)])
    case ...0xFFFF: out.append(type | 25); out.append(contentsOf: bigEndian(value, bytes: 2))
    case ...0xFFFF_FFFF: out.append(type | 26); out.append(contentsOf: bigEndian(value, bytes: 4))
    default: out.append(type | 27); out.append(contentsOf: bigEndian(value, bytes: 8))
    }
  }

  static func decode(_ data: Data) -> Value? {
    var reader = Reader(bytes: Array(data))
    guard let value = reader.value(depth: 0), reader.at == reader.bytes.count else { return nil }
    return value
  }

  static func decodePrefix(_ data: Data) -> (value: Value, length: Int)? {
    var reader = Reader(bytes: Array(data))
    guard let value = reader.value(depth: 0) else { return nil }
    return (value, reader.at)
  }

  private struct Reader {
    let bytes: [UInt8]
    var at = 0

    mutating func value(depth: Int) -> Value? {
      guard depth < 8, at < bytes.count else { return nil }
      let first = bytes[at]
      at += 1
      guard let argument = argument(first & 0x1F) else { return nil }
      switch first >> 5 {
      case 0: return argument <= UInt64(Int.max) ? .int(Int(argument)) : nil
      case 1: return argument < UInt64(Int.max) ? .int(-1 - Int(argument)) : nil
      case 2, 3:
        guard argument <= UInt64(bytes.count - at) else { return nil }
        let slice = Data(bytes[at..<(at + Int(argument))])
        at += Int(argument)
        if first >> 5 == 2 { return .bytes(slice) }
        return String(data: slice, encoding: .utf8).map(Value.text)
      case 5:
        guard argument <= 64 else { return nil }
        var pairs: [(Value, Value)] = []
        for _ in 0..<argument {
          guard let key = value(depth: depth + 1), let item = value(depth: depth + 1) else { return nil }
          pairs.append((key, item))
        }
        return .map(pairs)
      default: return nil
      }
    }

    mutating func argument(_ info: UInt8) -> UInt64? {
      if info < 24 { return UInt64(info) }
      let count: Int
      switch info {
      case 24: count = 1
      case 25: count = 2
      case 26: count = 4
      case 27: count = 8
      default: return nil
      }
      guard at + count <= bytes.count else { return nil }
      var result: UInt64 = 0
      for _ in 0..<count {
        result = result << 8 | UInt64(bytes[at])
        at += 1
      }
      return result
    }
  }

  static func bigEndian(_ value: UInt64, bytes: Int) -> [UInt8] {
    (0..<bytes).reversed().map { UInt8(truncatingIfNeeded: value >> (UInt64($0) * 8)) }
  }
}

enum VaultBase64URL {
  static func encode(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func decode(_ text: String, longest: Int = 1 << 16) -> Data? {
    guard text.count <= longest * 2, text.utf8.allSatisfy(isAlphabet) else { return nil }
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard base64.count % 4 != 1 else { return nil }
    while base64.count % 4 != 0 { base64.append("=") }
    guard let data = Data(base64Encoded: base64), data.count <= longest else { return nil }
    return data
  }

  private static func isAlphabet(_ byte: UInt8) -> Bool {
    (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39) || byte == 0x2D || byte == 0x5F
  }
}

enum VaultWebAuthn {
  static let es256 = -7
  static let zeroAAGUID = Data(count: 16)
  static let credentialIdLength = 16

  struct Flags: OptionSet, Sendable {
    let rawValue: UInt8
    static let userPresent = Flags(rawValue: 0x01)
    static let userVerified = Flags(rawValue: 0x04)
    static let backupEligible = Flags(rawValue: 0x08)
    static let backedUp = Flags(rawValue: 0x10)
    static let attestedCredential = Flags(rawValue: 0x40)
  }

  enum Ceremony: String {
    case create = "webauthn.create"
    case get = "webauthn.get"
  }

  static func clientDataJSON(_ ceremony: Ceremony, challenge: Data, origin: String) -> Data {
    let text = "{\"type\":\(quoted(ceremony.rawValue)),\"challenge\":\(quoted(VaultBase64URL.encode(challenge))),"
      + "\"origin\":\(quoted(origin)),\"crossOrigin\":false}"
    return Data(text.utf8)
  }

  static func quoted(_ text: String) -> String {
    var out = "\""
    for scalar in text.unicodeScalars {
      switch scalar.value {
      case 0x22: out += "\\\""
      case 0x5C: out += "\\\\"
      case 0x20...: out.unicodeScalars.append(scalar)
      default: out += String(format: "\\u%04x", scalar.value)
      }
    }
    return out + "\""
  }

  static func coseKey(_ key: P256.Signing.PublicKey) -> Data {
    let point = key.x963Representation
    let x = point.subdata(in: 1..<33)
    let y = point.subdata(in: 33..<65)
    return VaultCBOR.encode(.map([(.int(1), .int(2)), (.int(3), .int(es256)), (.int(-1), .int(1)), (.int(-2), .bytes(x)), (.int(-3), .bytes(y))]))
  }

  static func authenticatorData(rpId: String, flags: Flags, credentialId: Data? = nil, publicKey: P256.Signing.PublicKey? = nil) -> Data {
    var data = Data(SHA256.hash(data: Data(rpId.utf8)))
    var allFlags = flags
    if credentialId != nil, publicKey != nil { allFlags.insert(.attestedCredential) } else { allFlags.remove(.attestedCredential) }
    data.append(allFlags.rawValue)
    data.append(contentsOf: [0, 0, 0, 0])
    if let credentialId, let publicKey {
      data.append(zeroAAGUID)
      data.append(contentsOf: VaultCBOR.bigEndian(UInt64(credentialId.count), bytes: 2))
      data.append(credentialId)
      data.append(coseKey(publicKey))
    }
    return data
  }

  static func attestationObject(authenticatorData: Data) -> Data {
    VaultCBOR.encode(.map([(.text("fmt"), .text("none")), (.text("attStmt"), .map([])), (.text("authData"), .bytes(authenticatorData))]))
  }

  static func signature(_ key: P256.Signing.PrivateKey, authenticatorData: Data, clientDataJSON: Data) throws -> Data {
    var signed = authenticatorData
    signed.append(Data(SHA256.hash(data: clientDataJSON)))
    return try key.signature(for: signed).derRepresentation
  }

  static func authenticatorData(fromAttestation attestation: Data) -> Data? {
    guard case .map(let pairs)? = VaultCBOR.decode(attestation) else { return nil }
    for (key, value) in pairs {
      if case .text("authData") = key, case .bytes(let data) = value { return data }
    }
    return nil
  }

  static func publicKey(fromAuthenticatorData data: Data) -> P256.Signing.PublicKey? {
    let bytes = Array(data)
    guard bytes.count > 55, bytes[32] & Flags.attestedCredential.rawValue != 0 else { return nil }
    let idLength = Int(bytes[53]) << 8 | Int(bytes[54])
    guard bytes.count > 55 + idLength, case .map(let pairs)? = VaultCBOR.decodePrefix(Data(bytes[(55 + idLength)...]))?.value else { return nil }
    var x: Data?
    var y: Data?
    var algorithm: Int?
    for (key, value) in pairs {
      guard case .int(let label) = key else { continue }
      if label == 3, case .int(let alg) = value { algorithm = alg }
      if label == -2, case .bytes(let data) = value { x = data }
      if label == -3, case .bytes(let data) = value { y = data }
    }
    guard algorithm == es256, let x, let y, x.count == 32, y.count == 32 else { return nil }
    return try? P256.Signing.PublicKey(x963Representation: Data([4]) + x + y)
  }

  static func flags(backedUp: Bool) -> Flags {
    var flags: Flags = [.userPresent, .userVerified, .backupEligible]
    if backedUp { flags.insert(.backedUp) }
    return flags
  }

  static func newCredentialId() -> Data {
    var bytes = [UInt8](repeating: 0, count: credentialIdLength)
    for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255) }
    return Data(bytes)
  }
}

enum VaultRelyingParty {
  static let longestId = 253

  struct Site: Equatable, Sendable {
    var origin: String
    var host: String
    var rpId: String
  }

  static func originHost(_ origin: String) -> String? {
    guard origin.count <= 512, let split = origin.range(of: "://") else { return nil }
    let scheme = origin[..<split.lowerBound]
    let rest = origin[split.upperBound...]
    let parts = rest.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    let host = String(parts[0])
    if parts.count == 2 {
      guard let port = Int(parts[1]), port > 0, port <= 65535, String(port) == parts[1] else { return nil }
    }
    guard isDomain(host) else { return nil }
    if scheme == "https" { return host }
    if scheme == "http", host == "localhost" { return host }
    return nil
  }

  static func check(rpId requested: String?, origin: String) -> Site? {
    guard let host = originHost(origin) else { return nil }
    let rpId = requested ?? host
    guard rpId.count <= longestId, isDomain(rpId) else { return nil }
    if rpId == host { return host == "localhost" || !VaultOriginMatch.registrableDomain(host).isEmpty ? Site(origin: origin, host: host, rpId: rpId) : nil }
    guard host.hasSuffix("." + rpId), VaultPublicSuffix.suffix(of: rpId) != rpId, !VaultOriginMatch.registrableDomain(rpId).isEmpty else { return nil }
    return Site(origin: origin, host: host, rpId: rpId)
  }

  static func isDomain(_ text: String) -> Bool {
    guard !text.isEmpty, text.count <= longestId, !text.hasPrefix("."), !text.hasSuffix("."), !text.contains("..") else { return false }
    var digitsOnly = true
    for byte in text.utf8 {
      let letter = byte >= 0x61 && byte <= 0x7A
      let digit = byte >= 0x30 && byte <= 0x39
      guard letter || digit || byte == 0x2D || byte == 0x2E else { return false }
      if letter || byte == 0x2D { digitsOnly = false }
    }
    guard !digitsOnly else { return false }
    return text.split(separator: ".").allSatisfy { $0.count <= 63 && !$0.hasPrefix("-") && !$0.hasSuffix("-") }
  }
}
