import AuthenticationServices
import Foundation
import XCTest
@testable import ArdiaImportCore

@available(macOS 26, *)
final class CredentialExchangeTests: XCTestCase {
  func fixture() throws -> CredentialExchangeImport {
    let data = try Data(contentsOf: Fixtures.url("cxf/exchange.json"))
    return CredentialExchange.summarize(try CredentialExchange.decode(data))
  }

  func testLoginsCodesAndSkipsFromFixture() throws {
    let result = try fixture()
    XCTAssertEqual(result.exporter, "Passwords")
    XCTAssertEqual(result.source, .apple)
    XCTAssertEqual(result.logins, [
      ExchangedLogin(url: "https://login.example.test/signin", username: "alice", password: "fixture-pass-1"),
      ExchangedLogin(url: "https://a.example.test", username: "bob@example.test", password: "fixture-pass-2"),
      ExchangedLogin(url: "https://b.example.test/", username: "bob@example.test", password: "fixture-pass-2"),
    ])
    XCTAssertEqual(result.codes.map(\.url), ["https://login.example.test/signin", "https://codes.example.test/"])
    XCTAssertEqual(result.codes.map(\.username), ["alice", "erin"])
    XCTAssertEqual(result.passkeys, 1)
    XCTAssertEqual(result.noSite, 1)
    XCTAssertEqual(result.unsupported, 1)
  }

  func testOtpAuthKeepsTheSecretAndParameters() throws {
    let codes = try fixture().codes
    let first = try XCTUnwrap(URLComponents(string: codes[0].otpAuth))
    XCTAssertEqual(first.scheme, "otpauth")
    XCTAssertEqual(first.host, "totp")
    XCTAssertEqual(first.path, "/Example Co:alice")
    let query = Dictionary(uniqueKeysWithValues: (first.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    XCTAssertEqual(query["secret"], "JBSWY3DPEHPK3PXP")
    XCTAssertEqual(query["issuer"], "Example Co")
    XCTAssertEqual(query["algorithm"], "SHA1")
    XCTAssertEqual(query["digits"], "6")
    XCTAssertEqual(query["period"], "30")
    let second = try XCTUnwrap(URLComponents(string: codes[1].otpAuth))
    let other = Dictionary(uniqueKeysWithValues: (second.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    XCTAssertEqual(second.path, "/erin")
    XCTAssertEqual(other["secret"], "GEZDGNBVGY3TQOJQ")
    XCTAssertEqual(other["algorithm"], "SHA256")
    XCTAssertEqual(other["digits"], "8")
    XCTAssertEqual(other["period"], "60")
    XCTAssertNil(other["issuer"])
  }

  func testBase32MatchesRFC4648Vectors() {
    let vectors = ["": "", "f": "MY", "fo": "MZXQ", "foo": "MZXW6", "foob": "MZXW6YQ", "fooba": "MZXW6YTB", "foobar": "MZXW6YTBOI"]
    for (plain, encoded) in vectors { XCTAssertEqual(Base32.encode(Data(plain.utf8)), encoded) }
  }

  func testSourceKinds() {
    XCTAssertEqual(CredentialSourceKind.of(relyingParty: "1password.com", displayName: "1Password"), .onePassword)
    XCTAssertEqual(CredentialSourceKind.of(relyingParty: "bitwarden.com", displayName: "Bitwarden"), .bitwarden)
    XCTAssertEqual(CredentialSourceKind.of(relyingParty: "apple.com", displayName: "Passwords"), .apple)
    XCTAssertEqual(CredentialSourceKind.of(relyingParty: "example.test", displayName: "Vault"), .other)
  }

  func testRealTypesRoundTripThroughTheSameMapping() throws {
    let field = { (type: ASImportableEditableField.FieldType, value: String) in ASImportableEditableField(id: nil, fieldType: type, value: value) }
    let items = (0..<1000).map { n in
      ASImportableItem(
        id: Data("item-\(n)".utf8), created: Date(), lastModified: Date(), title: "Site \(n)",
        scope: ASImportableCredentialScope(urls: [URL(string: "https://site\(n).example.test/login")!]),
        credentials: [.basicAuthentication(.init(userName: field(.string, "user\(n)"), password: field(.concealedString, "pw-\(n)")))])
    }
    let data = ASExportedCredentialData(
      accounts: [ASImportableAccount(id: Data("a".utf8), userName: "", email: "", collections: [], items: items)],
      formatVersion: .v1, exporterRelyingPartyIdentifier: "1password.com", exporterDisplayName: "1Password", timestamp: Date())
    let decoded = try CredentialExchange.decode(JSONEncoder().encode(data))
    let start = Date()
    let result = CredentialExchange.summarize(decoded)
    let ms = Date().timeIntervalSince(start) * 1000
    XCTAssertEqual(result.source, .onePassword)
    XCTAssertEqual(result.logins.count, 1000)
    XCTAssertEqual(result.logins[999], ExchangedLogin(url: "https://site999.example.test/login", username: "user999", password: "pw-999"))
    XCTAssertLessThan(ms, 250)
  }

  func testNotCredentialExchangeIsUnsupported() {
    XCTAssertThrowsError(try CredentialExchange.decode(Data("{\"rows\":[]}".utf8))) { error in
      XCTAssertEqual((error as? ImportError)?.code, "unsupported")
    }
  }
}
