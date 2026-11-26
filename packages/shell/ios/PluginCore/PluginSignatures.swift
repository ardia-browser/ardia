import CryptoKit
import Foundation

enum PluginSignatures {
  static let spkiPrefix: [UInt8] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]

  static func bytes(_ text: String) -> Data? {
    var clean = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/").filter { !$0.isWhitespace }
    while clean.count % 4 != 0 { clean.append("=") }
    return Data(base64Encoded: clean)
  }

  static func rawKey(_ given: Data) -> Data? {
    if given.count == 32 { return given }
    if given.count == 44, Array(given.prefix(12)) == spkiPrefix { return given.suffix(32) }
    return nil
  }

  static func verify(publicKey: String, signature: String, message: String) -> Bool {
    guard let messageBytes = bytes(message) else { return false }
    return verify(publicKey: publicKey, signature: signature, data: messageBytes)
  }

  static func verify(publicKey: String, signature: String, data: Data) -> Bool {
    guard let keyBytes = bytes(publicKey).flatMap(rawKey), let signatureBytes = bytes(signature), signatureBytes.count == 64,
      let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyBytes)
    else { return false }
    return key.isValidSignature(signatureBytes, for: data)
  }
}
