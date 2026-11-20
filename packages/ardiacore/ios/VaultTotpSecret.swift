import CryptoKit
import Foundation

struct VaultTotpSecret: Equatable, Sendable {
  enum Algorithm: String, Sendable {
    case sha1, sha256, sha512

    init?(named name: String) {
      var plain = name.lowercased().filter { $0 != "-" && $0 != "_" && !$0.isWhitespace }
      if plain.hasPrefix("hmac") { plain.removeFirst(4) }
      self.init(rawValue: plain)
    }
  }

  enum Encoding: String, Sendable {
    case decimal, steam
  }

  static let digitRange = 6...8
  static let steamDigits = 5
  static let periodRange = 5...300
  static let longestText = 2048
  private static let steamAlphabet = Array("23456789BCDFGHJKMNPQRTVWXY")

  let key: Data
  let digits: Int
  let period: Int
  let algorithm: Algorithm
  let encoding: Encoding

  init(key: Data, digits: Int = 6, period: Int = VaultTotp.defaultPeriod, algorithm: Algorithm = .sha1, encoding: Encoding = .decimal) {
    self.key = key
    self.digits = encoding == .steam ? Self.steamDigits : digits
    self.period = period
    self.algorithm = algorithm
    self.encoding = encoding
  }

  init?(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= Self.longestText else { return nil }
    let lowered = trimmed.lowercased()
    if lowered.hasPrefix("steam://") {
      guard let key = Self.base32(String(trimmed.dropFirst("steam://".count))) else { return nil }
      self.init(key: key, encoding: .steam)
      return
    }
    if lowered.hasPrefix("otpauth://") {
      guard let parsed = Self.parseURI(trimmed) else { return nil }
      self = parsed
      return
    }
    guard !trimmed.contains("://"), let key = Self.base32(trimmed) else { return nil }
    self.init(key: key)
  }

  static func components(_ uri: String) -> URLComponents? {
    if let parsed = URLComponents(string: uri) { return parsed }
    var allowed = CharacterSet.urlFragmentAllowed
    allowed.insert("%")
    guard let escaped = uri.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
    return URLComponents(string: escaped)
  }

  static func query(_ components: URLComponents) -> [String: String] {
    var query: [String: String] = [:]
    for item in components.queryItems ?? [] where query[item.name.lowercased()] == nil {
      query[item.name.lowercased()] = item.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
    return query
  }

  private static func parseURI(_ uri: String) -> VaultTotpSecret? {
    guard let components = components(uri), components.scheme?.lowercased() == "otpauth", components.host?.lowercased() == "totp" else {
      return nil
    }
    let query = query(components)
    guard let secret = query["secret"], let key = base32(secret) else { return nil }
    let steam = query["encoder"]?.lowercased() == "steam" || (query["digits"] == "\(steamDigits)" && query["issuer"]?.lowercased() == "steam")
    let digits: Int
    if let text = query["digits"], !text.isEmpty {
      guard let value = Int(text) else { return nil }
      digits = value
    } else {
      digits = steam ? steamDigits : 6
    }
    let period: Int
    if let text = query["period"], !text.isEmpty {
      guard let value = Int(text) else { return nil }
      period = value
    } else {
      period = VaultTotp.defaultPeriod
    }
    let algorithm: Algorithm
    if let name = query["algorithm"], !name.isEmpty {
      guard let named = Algorithm(named: name) else { return nil }
      algorithm = named
    } else {
      algorithm = .sha1
    }
    guard periodRange.contains(period) else { return nil }
    if steam {
      guard digits == steamDigits else { return nil }
      return VaultTotpSecret(key: key, period: period, algorithm: algorithm, encoding: .steam)
    }
    guard digitRange.contains(digits) else { return nil }
    return VaultTotpSecret(key: key, digits: digits, period: period, algorithm: algorithm)
  }

  func counter(at date: Date) -> UInt64 {
    let seconds = date.timeIntervalSince1970
    guard seconds.isFinite, seconds > 0 else { return 0 }
    return UInt64(floor(seconds / Double(period)))
  }

  func code(at date: Date = Date()) -> String { code(counter: counter(at: date)) }

  func code(counter: UInt64) -> String {
    let message = withUnsafeBytes(of: counter.bigEndian) { Data($0) }
    let symmetric = SymmetricKey(data: key)
    let mac: [UInt8]
    switch algorithm {
    case .sha1: mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: message, using: symmetric))
    case .sha256: mac = Array(HMAC<SHA256>.authenticationCode(for: message, using: symmetric))
    case .sha512: mac = Array(HMAC<SHA512>.authenticationCode(for: message, using: symmetric))
    }
    let offset = Int(mac[mac.count - 1] & 0x0f)
    var binary = (UInt32(mac[offset] & 0x7f) << 24) | (UInt32(mac[offset + 1]) << 16) | (UInt32(mac[offset + 2]) << 8) | UInt32(mac[offset + 3])
    if encoding == .steam {
      var letters = ""
      for _ in 0..<Self.steamDigits {
        letters.append(Self.steamAlphabet[Int(binary % UInt32(Self.steamAlphabet.count))])
        binary /= UInt32(Self.steamAlphabet.count)
      }
      return letters
    }
    var modulus: UInt32 = 1
    for _ in 0..<digits { modulus *= 10 }
    let value = String(binary % modulus)
    return String(repeating: "0", count: max(0, digits - value.count)) + value
  }

  func totp(at date: Date = Date()) -> VaultTotp? {
    let counter = counter(at: date)
    guard var made = VaultTotp.make(code: code(counter: counter), period: period, now: date) else { return nil }
    made.next = code(counter: counter + 1)
    return made
  }

  private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

  static func cleanedKey(_ text: String) -> String {
    var cleaned = text.uppercased().filter { !$0.isWhitespace && $0 != "-" }
    while cleaned.hasSuffix("=") { cleaned.removeLast() }
    return cleaned
  }

  static func base32(_ text: String) -> Data? {
    let cleaned = cleanedKey(text)
    guard !cleaned.isEmpty, cleaned.count <= longestText else { return nil }
    var buffer: UInt32 = 0
    var bits = 0
    var bytes: [UInt8] = []
    for character in cleaned {
      guard let index = alphabet.firstIndex(of: character) else { return nil }
      buffer = (buffer << 5) | UInt32(index)
      bits += 5
      if bits >= 8 {
        bits -= 8
        bytes.append(UInt8((buffer >> UInt32(bits)) & 0xff))
      }
    }
    return bytes.isEmpty ? nil : Data(bytes)
  }
}
