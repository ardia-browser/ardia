import CryptoKit
import Foundation

struct VerificationCode: Codable, Equatable {
  let secret: Data
  let algorithm: String
  let digits: Int
  let period: Int
  let account: String
  let issuer: String

  init?(otpauth text: String) {
    guard text.utf8.count <= 2048, let parts = URLComponents(string: text), parts.scheme?.lowercased() == "otpauth", parts.host?.lowercased() == "totp" else { return nil }
    var query: [String: String] = [:]
    for item in parts.queryItems ?? [] {
      if let value = item.value, query[item.name.lowercased()] == nil { query[item.name.lowercased()] = value }
    }
    guard let secret = query["secret"].flatMap(Self.base32), (10...128).contains(secret.count) else { return nil }
    let algorithm = (query["algorithm"] ?? "SHA1").uppercased()
    guard ["SHA1", "SHA256", "SHA512"].contains(algorithm), let digits = Int(query["digits"] ?? "6"), let period = Int(query["period"] ?? "30"), (6...8).contains(digits), (10...300).contains(period) else { return nil }
    let label = parts.path.hasPrefix("/") ? String(parts.path.dropFirst()) : parts.path
    let split = label.firstIndex(of: ":")
    self.secret = secret
    self.algorithm = algorithm
    self.digits = digits
    self.period = period
    self.account = (split.map { String(label[label.index(after: $0)...]) } ?? label).trimmingCharacters(in: .whitespaces)
    self.issuer = query["issuer"] ?? split.map { String(label[..<$0]) } ?? ""
  }

  func code(at date: Date) -> String {
    var counter = UInt64(max(0, date.timeIntervalSince1970) / Double(period)).bigEndian
    let message = Data(bytes: &counter, count: MemoryLayout<UInt64>.size)
    let key = SymmetricKey(data: secret)
    let mac: [UInt8]
    switch algorithm {
    case "SHA256": mac = Array(HMAC<SHA256>.authenticationCode(for: message, using: key))
    case "SHA512": mac = Array(HMAC<SHA512>.authenticationCode(for: message, using: key))
    default: mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: message, using: key))
    }
    let offset = Int(mac[mac.count - 1] & 0x0f)
    let value = (UInt32(mac[offset] & 0x7f) << 24) | (UInt32(mac[offset + 1]) << 16) | (UInt32(mac[offset + 2]) << 8) | UInt32(mac[offset + 3])
    var modulo: UInt32 = 1
    for _ in 0..<digits { modulo *= 10 }
    let digitsText = String(value % modulo)
    return String(repeating: "0", count: max(0, digits - digitsText.count)) + digitsText
  }

  static func base32(_ text: String) -> Data? {
    let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".utf8)
    var lookup = [UInt8: UInt8]()
    for (index, char) in alphabet.enumerated() { lookup[char] = UInt8(index) }
    var bits: UInt32 = 0
    var count = 0
    var out = Data()
    for char in text.uppercased().utf8 where char != UInt8(ascii: "=") && char != UInt8(ascii: " ") && char != UInt8(ascii: "-") {
      guard let value = lookup[char] else { return nil }
      bits = (bits << 5) | UInt32(value)
      count += 5
      if count >= 8 {
        count -= 8
        out.append(UInt8((bits >> UInt32(count)) & 0xff))
      }
    }
    return out
  }
}
