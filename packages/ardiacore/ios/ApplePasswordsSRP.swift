import CryptoKit
import Foundation
import Security

struct SRPNumber: Comparable {
  private(set) var digits: [UInt32]

  init(_ value: UInt32) { digits = value == 0 ? [] : [value] }

  init(_ bytes: [UInt8]) {
    var out: [UInt32] = []
    var end = bytes.count
    while end > 0 {
      let start = max(0, end - 4)
      var word: UInt32 = 0
      for byte in bytes[start..<end] { word = word << 8 | UInt32(byte) }
      out.append(word)
      end = start
    }
    digits = out
    trim()
  }

  init(hex: String) {
    var bytes: [UInt8] = []
    var text = Substring(hex)
    if text.count % 2 == 1 { text = "0" + text }
    while !text.isEmpty {
      bytes.append(UInt8(text.prefix(2), radix: 16) ?? 0)
      text = text.dropFirst(2)
    }
    self.init(bytes)
  }

  private init(digits: [UInt32]) {
    self.digits = digits
    trim()
  }

  private mutating func trim() {
    while digits.last == 0 { digits.removeLast() }
  }

  var isZero: Bool { digits.isEmpty }

  var bytes: [UInt8] {
    var out: [UInt8] = []
    for word in digits.reversed() {
      out += [UInt8(word >> 24), UInt8(word >> 16 & 0xff), UInt8(word >> 8 & 0xff), UInt8(word & 0xff)]
    }
    return Array(out.drop { $0 == 0 })
  }

  func padded(_ length: Int) -> [UInt8] {
    let plain = bytes
    return [UInt8](repeating: 0, count: max(0, length - plain.count)) + plain
  }

  static func < (a: SRPNumber, b: SRPNumber) -> Bool {
    if a.digits.count != b.digits.count { return a.digits.count < b.digits.count }
    for i in stride(from: a.digits.count - 1, through: 0, by: -1) where a.digits[i] != b.digits[i] {
      return a.digits[i] < b.digits[i]
    }
    return false
  }

  static func + (a: SRPNumber, b: SRPNumber) -> SRPNumber {
    var out = [UInt32](repeating: 0, count: max(a.digits.count, b.digits.count) + 1)
    var carry: UInt64 = 0
    for i in 0..<(out.count - 1) {
      let sum = UInt64(i < a.digits.count ? a.digits[i] : 0) + UInt64(i < b.digits.count ? b.digits[i] : 0) + carry
      out[i] = UInt32(truncatingIfNeeded: sum)
      carry = sum >> 32
    }
    out[out.count - 1] = UInt32(carry)
    return SRPNumber(digits: out)
  }

  static func - (a: SRPNumber, b: SRPNumber) -> SRPNumber {
    precondition(!(a < b), "SRPNumber subtraction below zero")
    var out = a.digits
    var borrow: Int64 = 0
    for i in 0..<out.count {
      let difference = Int64(out[i]) - Int64(i < b.digits.count ? b.digits[i] : 0) - borrow
      out[i] = UInt32(truncatingIfNeeded: difference)
      borrow = difference < 0 ? 1 : 0
    }
    return SRPNumber(digits: out)
  }

  static func * (a: SRPNumber, b: SRPNumber) -> SRPNumber {
    guard !a.isZero, !b.isZero else { return SRPNumber(0) }
    var out = [UInt32](repeating: 0, count: a.digits.count + b.digits.count)
    for i in 0..<a.digits.count {
      var carry: UInt64 = 0
      let x = UInt64(a.digits[i])
      for j in 0..<b.digits.count {
        let product = x * UInt64(b.digits[j]) + UInt64(out[i + j]) + carry
        out[i + j] = UInt32(truncatingIfNeeded: product)
        carry = product >> 32
      }
      out[i + b.digits.count] = UInt32(carry)
    }
    return SRPNumber(digits: out)
  }

  private func shifted(left bits: Int) -> [UInt32] {
    guard bits > 0 else { return digits }
    var out = [UInt32](repeating: 0, count: digits.count + 1)
    for i in 0..<digits.count {
      out[i] |= digits[i] << bits
      out[i + 1] = digits[i] >> (32 - bits)
    }
    return out
  }

  static func % (a: SRPNumber, m: SRPNumber) -> SRPNumber {
    precondition(!m.isZero, "SRPNumber mod zero")
    if a < m { return a }
    if m.digits.count == 1 {
      var rest: UInt64 = 0
      let d = UInt64(m.digits[0])
      for word in a.digits.reversed() { rest = (rest << 32 | UInt64(word)) % d }
      return SRPNumber(UInt32(rest))
    }
    let shift = m.digits.last!.leadingZeroBitCount
    var v = m.shifted(left: shift)
    if v.last == 0 { v.removeLast() }
    let n = v.count
    var u = a.shifted(left: shift)
    if u.count == a.digits.count { u.append(0) }
    let base: UInt64 = 1 << 32
    for j in stride(from: u.count - n - 1, through: 0, by: -1) {
      let top = UInt64(u[j + n]) << 32 | UInt64(u[j + n - 1])
      var q = top / UInt64(v[n - 1])
      var r = top % UInt64(v[n - 1])
      while q >= base || q * UInt64(v[n - 2]) > (r << 32 | UInt64(u[j + n - 2])) {
        q -= 1
        r += UInt64(v[n - 1])
        if r >= base { break }
      }
      var k: Int64 = 0
      for i in 0..<n {
        let product = q * UInt64(v[i])
        let t = Int64(u[i + j]) - k - Int64(product & 0xffff_ffff)
        u[i + j] = UInt32(truncatingIfNeeded: t)
        k = Int64(product >> 32) - (t >> 32)
      }
      let t = Int64(u[j + n]) - k
      u[j + n] = UInt32(truncatingIfNeeded: t)
      if t < 0 {
        var carry: UInt64 = 0
        for i in 0..<n {
          let sum = UInt64(u[i + j]) + UInt64(v[i]) + carry
          u[i + j] = UInt32(truncatingIfNeeded: sum)
          carry = sum >> 32
        }
        u[j + n] = UInt32(truncatingIfNeeded: UInt64(u[j + n]) + carry)
      }
    }
    var rest = [UInt32](repeating: 0, count: n)
    for i in 0..<n {
      rest[i] = shift == 0 ? u[i] : (u[i] >> shift) | (u[i + 1] << (32 - shift))
    }
    return SRPNumber(digits: rest)
  }

  func power(_ exponent: SRPNumber, mod m: SRPNumber) -> SRPNumber {
    var result = SRPNumber(1) % m
    var base = self % m
    for word in exponent.digits {
      var bits = word
      for _ in 0..<32 {
        if bits & 1 == 1 { result = (result * base) % m }
        base = (base * base) % m
        bits >>= 1
      }
    }
    return result
  }
}

struct ApplePasswordsSRP {
  static let N = SRPNumber(hex: """
  FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B30\
  2B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE6492866\
  51ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4A\
  BC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956A\
  E515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7AB\
  F5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988\
  C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF
  """)
  static let g = SRPNumber(5)
  static let length = 384

  enum Failure: Error, Equatable {
    case wrongCode, unexpected, refused
  }

  let base64: Bool
  private let I: SRPNumber
  private let a: SRPNumber
  let A: SRPNumber
  private(set) var key: SymmetricKey?
  private var hamk: [UInt8] = []
  private var salt: [UInt8] = []
  private var B = SRPNumber(0)

  init(base64: Bool, random: (Int) -> [UInt8] = ApplePasswordsSRP.random) {
    self.base64 = base64
    var tid = random(16)
    while tid.first == 0 { tid = random(16) }
    I = SRPNumber(tid)
    a = SRPNumber(random(32))
    A = Self.g.power(a, mod: Self.N)
  }

  static func random(_ count: Int) -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: count)
    _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    return bytes
  }

  func text(_ bytes: [UInt8], prefixed: Bool = true) -> String {
    base64 ? Data(bytes).base64EncodedString() : (prefixed ? "0x" : "") + bytes.map { String(format: "%02x", $0) }.joined()
  }

  func bytes(_ text: String) -> [UInt8]? {
    if base64 { return Data(base64Encoded: text).map { [UInt8]($0) } }
    var hex = Substring(text.hasPrefix("0x") ? String(text.dropFirst(2)) : text)
    if hex.count % 2 == 1 { hex = "0" + hex }
    var out: [UInt8] = []
    while !hex.isEmpty {
      guard let byte = UInt8(hex.prefix(2), radix: 16) else { return nil }
      out.append(byte)
      hex = hex.dropFirst(2)
    }
    return out
  }

  var tid: String { text(I.bytes) }

  private static func sha(_ parts: [UInt8]...) -> [UInt8] {
    var hash = SHA256()
    for part in parts { hash.update(data: part) }
    return Array(hash.finalize())
  }

  private static func pake(_ object: [String: Any]) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    return data.base64EncodedString()
  }

  private static func unpake(_ text: String) -> [String: Any]? {
    guard let data = Data(base64Encoded: text) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  var first: String {
    Self.pake(["TID": tid, "MSG": 0, "A": text(A.bytes), "VER": "1.0", "PROTO": [0, 1]])
  }

  mutating func second(after reply: String, code: String) throws -> String {
    guard let message = Self.unpake(reply), message["TID"] as? String == tid,
              message["MSG"] as? Int == 1, message["ErrCode"] == nil,
              let s = (message["s"] as? String).flatMap(bytes),
              let b = (message["B"] as? String).flatMap(bytes)
    else { throw Failure.unexpected }
    let proto = message["PROTO"] as? Int ?? 0
    guard proto == 1 else { throw Failure.refused }
    let N = Self.N
    B = SRPNumber(b)
    guard !(B % N).isZero else { throw Failure.unexpected }
    salt = s
    let x = SRPNumber(Self.sha(s, Self.sha(Array((tid + ":" + code).utf8))))
    let v = Self.g.power(x, mod: N)
    let u = SRPNumber(Self.sha(A.padded(Self.length), B.padded(Self.length)))
    let k = SRPNumber(Self.sha(N.padded(Self.length), Self.g.padded(Self.length)))
    let kv = (k * v) % N
    let base = ((B % N) + N - kv) % N
    let S = base.power(a + u * x, mod: N)
    let K = Self.sha(S.bytes)
    key = SymmetricKey(data: K.prefix(16))
    let hn = Self.sha(N.bytes)
    let hg = Self.sha(Self.g.padded(Self.length))
    let xored = zip(hn, hg).map { $0 ^ $1 }
    let M = Self.sha(xored, Self.sha(Array(tid.utf8)), s, A.bytes, B.bytes, K)
    hamk = Self.sha(A.bytes, M, K)
    return Self.pake(["TID": tid, "MSG": 2, "M": text(M, prefixed: false)])
  }

  func third(_ reply: String) throws {
    guard let message = Self.unpake(reply), message["TID"] as? String == tid else { throw Failure.unexpected }
    let error = message["ErrCode"] as? Int ?? 0
    if error == 1 { throw Failure.wrongCode }
    guard error == 0, let proof = (message["HAMK"] as? String).flatMap(bytes), proof == hamk else {
      throw Failure.wrongCode
    }
  }
}
