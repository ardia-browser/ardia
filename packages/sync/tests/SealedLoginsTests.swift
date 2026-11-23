import Foundation
import XCTest
@testable import ArdiaSyncCore

final class SealedLoginsTests: XCTestCase {
  struct Refused: Error {}

  let reply: [String: Any] = ["logins": [
    ["realm": "https://a.example/", "username": "ada", "password": "a-secret", "created": 1.0],
    ["realm": "https://b.example/", "username": "bo", "password": "b-secret", "created": 2.0],
    ["realm": "https://a.example/", "username": "ada", "password": "again", "created": 3.0],
    ["realm": "android://app", "username": "cy", "password": "c-secret", "created": 4.0],
  ]]

  func testALoginThatWontSealIsListedAsPasswordlessNotLeftOut() throws {
    let logins = try XCTUnwrap(SealedLogins.from(reply) { password, origin, username in
      if username == "bo" { throw Refused() }
      return "sealed:\(password)@\(origin)/\(username)"
    })
    XCTAssertEqual(logins.count, 2)
    XCTAssertEqual(logins[0]["origin"] as? String, "https://a.example")
    XCTAssertEqual(logins[0]["sealed"] as? String, "sealed:a-secret@https://a.example/ada")
    XCTAssertNil(logins[0]["passwordless"])
    XCTAssertEqual(logins[1]["origin"] as? String, "https://b.example")
    XCTAssertEqual(logins[1]["username"] as? String, "bo")
    XCTAssertEqual(logins[1]["passwordless"] as? Bool, true)
    XCTAssertEqual(logins[1]["created"] as? Double, 2.0)
    XCTAssertNil(logins[1]["sealed"])
    XCTAssertFalse(logins.contains { ($0["sealed"] as? String)?.contains("b-secret") == true })
  }

  func testEveryLoginSealsWithRealKeys() throws {
    let keys = SyncKeys(entropy: Data(repeating: 3, count: 32))
    let logins = try XCTUnwrap(SealedLogins.from(reply, seal: keys.sealPassword))
    XCTAssertEqual(logins.map { $0["username"] as? String }, ["ada", "bo"])
    for login in logins {
      let sealed = try XCTUnwrap(login["sealed"] as? String)
      let password = try keys.openPassword(sealed, origin: login["origin"] as! String, username: login["username"] as! String)
      XCTAssertEqual(password, login["username"] as? String == "ada" ? "a-secret" : "b-secret")
    }
  }

  func testAMalformedOrMissingReplyReadsAsNothingThisTime() {
    XCTAssertNil(SealedLogins.from(nil) { _, _, _ in "x" })
    XCTAssertNil(SealedLogins.from(["error": "locked"]) { _, _, _ in "x" })
    XCTAssertNil(SealedLogins.from(["logins": [["realm": "https://a.example/", "username": "ada", "created": 1.0]]]) { _, _, _ in "x" })
  }
}
