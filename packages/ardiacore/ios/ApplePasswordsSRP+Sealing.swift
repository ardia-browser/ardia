import CryptoKit
import Foundation

extension ApplePasswordsSRP {
  static let nonceBytes = 16
  static let tagBytes = 16

  func seal(_ object: [String: Any]) throws -> String {
    guard let key else { throw Failure.unexpected }
    let plain = try JSONSerialization.data(withJSONObject: object)
    let box = try AES.GCM.seal(plain, using: key, nonce: AES.GCM.Nonce(data: Self.random(Self.nonceBytes)))
    let sdata = text([UInt8](box.ciphertext) + [UInt8](box.tag) + [UInt8](box.nonce), prefixed: false)
    let envelope = try JSONSerialization.data(withJSONObject: ["TID": tid, "SDATA": sdata])
    return String(decoding: envelope, as: UTF8.self)
  }

  func open(_ smsg: Any?) -> [String: Any]? {
    guard let key, let envelope = Self.object(smsg), envelope["TID"] as? String == tid,
      let sdata = (envelope["SDATA"] as? String).flatMap(bytes), sdata.count > Self.nonceBytes + Self.tagBytes,
      let nonce = try? AES.GCM.Nonce(data: sdata.prefix(Self.nonceBytes)),
      let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: sdata[Self.nonceBytes..<sdata.count - Self.tagBytes], tag: sdata.suffix(Self.tagBytes)),
      let plain = try? AES.GCM.open(box, using: key)
    else { return nil }
    return (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any]
  }

  static func object(_ value: Any?) -> [String: Any]? {
    if let object = value as? [String: Any] { return object }
    guard let text = value as? String, let data = text.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
}
