import CryptoKit
import Foundation
import XCTest
@testable import ArdiaSyncCore

final class VaultPhoneKeysTests: XCTestCase {
  private let nodeKey = "BFppipwL1+pw2vDPx4Fg5JgYsZxPE8Ego6MOTMbcX7F5cqenWd372LLFNgkTuDHryMSjN7WgOxXogvRsJqkjptg="
  private let nodeMessage = "20:ardia-vault-answer-136:0f0e0d0c-0b0a-4908-8706-05040302010022:n0nce-0123456789abcdef3:p:11:117:https://a.example13:18000000000001:126:mac0000000000000000000000027:phone00000000000000000000001:11:0"
  private let nodeSignature = "LdJKglH9LOXOk0ReHLHOr3/JI5ue/GmIzeJ+JaEGB5MaLn5+fZvuGtKUQ9e8bDpKX63olEYs9UfMKKpeQNBRJA=="

  func testFingerprintAndSignatureMatchWhatNodeMakes() {
    let key = Data(base64Encoded: nodeKey)!
    XCTAssertEqual(VaultPhoneKeys.fingerprint(of: key), "4979 42AC F8F3 4E6A 2DBB")
    XCTAssertTrue(VaultPhoneKeys.verify(publicKey: key, message: nodeMessage, signature: Data(base64Encoded: nodeSignature)!))
    XCTAssertFalse(VaultPhoneKeys.verify(publicKey: key, message: nodeMessage.replacingOccurrences(of: "1:11:0", with: "1:11:1"), signature: Data(base64Encoded: nodeSignature)!))
    XCTAssertNil(VaultPhoneKeys.fingerprint(of: Data(repeating: 4, count: 65)))
  }

  func testAPhoneSignatureVerifiesOnlyAgainstItsOwnKey() throws {
    let phone = P256.Signing.PrivateKey()
    let other = P256.Signing.PrivateKey()
    let signature = try phone.signature(for: Data(nodeMessage.utf8)).rawRepresentation
    XCTAssertTrue(VaultPhoneKeys.verify(publicKey: phone.publicKey.x963Representation, message: nodeMessage, signature: signature))
    XCTAssertFalse(VaultPhoneKeys.verify(publicKey: other.publicKey.x963Representation, message: nodeMessage, signature: signature))
  }

  func testTrustedKeysAreKeptPerPhoneAndForgettingRevokes() throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("vault-phones-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: file) }
    let trust = VaultPhoneTrust(store: SecretFile(url: file))
    let phone = P256.Signing.PrivateKey()
    let signature = try phone.signature(for: Data(nodeMessage.utf8)).rawRepresentation.base64EncodedString()
    XCTAssertEqual(trust.verify(phone: "phone1", message: nodeMessage, signature: signature), .unenrolled)
    XCTAssertFalse(trust.trust(phone: "phone1", key: Data(repeating: 1, count: 65).base64EncodedString()))
    XCTAssertTrue(trust.trust(phone: "phone1", key: phone.publicKey.x963Representation.base64EncodedString()))
    XCTAssertEqual(trust.trusted().map(\.phone), ["phone1"])
    XCTAssertEqual(trust.trusted().first?.fingerprint, VaultPhoneKeys.fingerprint(of: phone.publicKey.x963Representation))
    XCTAssertEqual(trust.verify(phone: "phone1", message: nodeMessage, signature: signature), .ok)
    XCTAssertEqual(trust.verify(phone: "phone2", message: nodeMessage, signature: signature), .unenrolled)
    XCTAssertEqual(trust.verify(phone: "phone1", message: nodeMessage + "x", signature: signature), .badSignature)
    XCTAssertTrue(trust.forget(phone: "phone1"))
    XCTAssertEqual(trust.trusted().count, 0)
    XCTAssertEqual(trust.verify(phone: "phone1", message: nodeMessage, signature: signature), .unenrolled)
  }
}
