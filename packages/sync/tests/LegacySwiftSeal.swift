import CryptoKit
import Foundation
@testable import ArdiaSyncCore

struct LegacySwiftSeal {
  enum Failure: Error { case format, authentication }

  static let magic = Data(LegacyName.syncMagic.utf8)
  static let salt = Data(LegacyName.syncSalt.utf8)

  let fileKey: SymmetricKey
  let nameKey: SymmetricKey
  let passwordKey: SymmetricKey
  let passwordNonceKey: SymmetricKey

  init(entropy: Data) {
    let ikm = SymmetricKey(data: entropy)
    func derive(_ info: String) -> SymmetricKey {
      HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: Self.salt, info: Data(info.utf8), outputByteCount: 32)
    }
    fileKey = derive("file-key")
    nameKey = derive("name-key")
    passwordKey = derive("password-key")
    passwordNonceKey = derive("password-nonce-key")
  }

  func tag(_ label: String) -> String {
    let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")
    var out = ""
    var buffer = 0, bits = 0
    for byte in Data(HMAC<SHA256>.authenticationCode(for: Data(label.utf8), using: nameKey)).prefix(16) {
      buffer = buffer << 8 | Int(byte)
      bits += 8
      while bits >= 5 {
        out.append(alphabet[(buffer >> (bits - 5)) & 31])
        bits -= 5
      }
      buffer &= (1 << bits) - 1
    }
    if bits > 0 { out.append(alphabet[(buffer << (5 - bits)) & 31]) }
    return out
  }

  var chainTag: String { tag("chain") }

  func scopeTag(_ scope: String) -> String { tag("scope/" + scope) }

  func associatedData(scope: String, file: String) -> Data {
    Self.magic + Data("\(chainTag)/\(scope)/\(file)".utf8)
  }

  func seal(_ payload: Data, scopeTag: String, fileId: String) throws -> Data {
    var plain = withUnsafeBytes(of: UInt32(payload.count).bigEndian) { Data($0) } + payload
    plain.append(Data(count: (1024 - plain.count % 1024) % 1024))
    let box = try AES.GCM.seal(plain, using: fileKey, authenticating: associatedData(scope: scopeTag, file: fileId))
    return Self.magic + box.nonce + box.ciphertext + box.tag
  }

  func open(_ file: Data, scopeTag: String, fileId: String) throws -> Data {
    guard file.count >= Self.magic.count + 32, file.prefix(Self.magic.count) == Self.magic else { throw Failure.format }
    let body = file.dropFirst(Self.magic.count)
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: body.prefix(12)), ciphertext: body.dropFirst(12).dropLast(16), tag: body.suffix(16))
    let plain = try AES.GCM.open(box, using: fileKey, authenticating: associatedData(scope: scopeTag, file: fileId))
    let length = plain.prefix(4).reduce(0) { $0 << 8 | Int($1) }
    guard length <= plain.count - 4 else { throw Failure.format }
    return Data(plain.dropFirst(4).prefix(length))
  }

  static func passwordAssociatedData(origin: String, username: String) -> Data {
    let originBytes = Data(origin.utf8)
    return magic + Data("password/".utf8) + withUnsafeBytes(of: UInt32(originBytes.count).bigEndian) { Data($0) } + originBytes + Data(username.utf8)
  }

  func sealPassword(_ password: String, origin: String, username: String) throws -> String {
    let payload = Data(password.utf8)
    var plain = withUnsafeBytes(of: UInt32(payload.count).bigEndian) { Data($0) } + payload
    plain.append(Data(count: (32 - plain.count % 32) % 32))
    let aad = Self.passwordAssociatedData(origin: origin, username: username)
    let synthetic = withUnsafeBytes(of: UInt32(aad.count).bigEndian) { Data($0) } + aad + plain
    let nonce = try AES.GCM.Nonce(data: Data(HMAC<SHA256>.authenticationCode(for: synthetic, using: passwordNonceKey)).prefix(12))
    let box = try AES.GCM.seal(plain, using: passwordKey, nonce: nonce, authenticating: aad)
    return (Data([1]) + box.nonce + box.ciphertext + box.tag).base64EncodedString()
  }

  func openPassword(_ sealed: String, origin: String, username: String) throws -> String {
    guard let data = Data(base64Encoded: sealed), data.count >= 33, data.first == 1 else { throw Failure.format }
    let body = data.dropFirst()
    let aad = Self.passwordAssociatedData(origin: origin, username: username)
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: body.prefix(12)), ciphertext: body.dropFirst(12).dropLast(16), tag: body.suffix(16))
    let plain = try AES.GCM.open(box, using: passwordKey, authenticating: aad)
    let length = plain.prefix(4).reduce(0) { $0 << 8 | Int($1) }
    guard length <= plain.count - 4, let password = String(data: Data(plain.dropFirst(4).prefix(length)), encoding: .utf8) else { throw Failure.format }
    return password
  }
}
