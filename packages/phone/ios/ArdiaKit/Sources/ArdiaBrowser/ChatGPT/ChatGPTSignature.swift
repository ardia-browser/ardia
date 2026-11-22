import Foundation
import Security

public enum ChatGPTSignature {
  public static func verify(idToken: String, jwks: Data) throws(ChatGPTFailure) {
    let parts = idToken.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3,
          let headerData = Data(base64URLEncoded: String(parts[0])),
          let header = try? JSONSerialization.jsonObject(with: headerData) as? [String: Any],
          header["alg"] as? String == "RS256",
          let signature = Data(base64URLEncoded: String(parts[2])), !signature.isEmpty,
          let set = try? JSONSerialization.jsonObject(with: jwks) as? [String: Any],
          let keys = set["keys"] as? [[String: Any]] else {
      throw .invalidIdentity
    }
    let usable = keys.filter { key in
      key["kty"] as? String == "RSA" && (key["use"] == nil || key["use"] as? String == "sig") && (key["alg"] == nil || key["alg"] as? String == "RS256")
    }
    let kid = header["kid"] as? String
    let candidates = kid.map { kid in usable.filter { $0["kid"] as? String == kid } } ?? (usable.count == 1 ? usable : [])
    guard let jwk = candidates.first,
          let modulus = (jwk["n"] as? String).flatMap(Data.init(base64URLEncoded:)),
          let exponent = (jwk["e"] as? String).flatMap(Data.init(base64URLEncoded:)),
          modulus.count >= 256,
          let key = SecKeyCreateWithData(
            publicKeyDER(modulus: modulus, exponent: exponent) as CFData,
            [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic] as CFDictionary,
            nil
          ) else {
      throw .invalidIdentity
    }
    let signingInput = Data("\(parts[0]).\(parts[1])".utf8)
    guard SecKeyVerifySignature(key, .rsaSignatureMessagePKCS1v15SHA256, signingInput as CFData, signature as CFData, nil) else {
      throw .invalidIdentity
    }
  }

  public static func publicKeyDER(modulus: Data, exponent: Data) -> Data {
    der(tag: 0x30, der(tag: 0x02, unsigned(modulus)) + der(tag: 0x02, unsigned(exponent)))
  }

  static func unsigned(_ bytes: Data) -> Data {
    let trimmed = bytes.drop { $0 == 0 }
    guard let first = trimmed.first else { return Data([0]) }
    return first & 0x80 != 0 ? Data([0]) + trimmed : Data(trimmed)
  }

  static func der(tag: UInt8, _ content: Data) -> Data {
    var length = Data()
    if content.count < 0x80 {
      length.append(UInt8(content.count))
    } else {
      var count = content.count
      var bytes: [UInt8] = []
      while count > 0 {
        bytes.insert(UInt8(count & 0xff), at: 0)
        count >>= 8
      }
      length.append(0x80 | UInt8(bytes.count))
      length.append(contentsOf: bytes)
    }
    return Data([tag]) + length + content
  }
}
