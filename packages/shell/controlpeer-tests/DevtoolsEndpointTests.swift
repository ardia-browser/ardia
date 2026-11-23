import ArdiaControlPeerCore
import Foundation
import XCTest

final class DevtoolsEndpointTests: XCTestCase {
  private let token = "Canary-DevTools-Token_0123456789abcdefABCDEF"

  func testAnEngineReplyCarriesTheTokenInProcess() throws {
    XCTAssertEqual(try DevtoolsEndpoint.read(engineReply: ["port": 41234, "generation": 3, "token": token]).get(), DevtoolsEndpoint(port: 41234, generation: 3, token: token))
  }

  func testAServerThatIsntOnHasNoEndpoint() {
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["state": "off"]), .failure(.off))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["error": "profile not loaded"]), .failure(.off))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: [:]), .failure(.off))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["port": 0, "generation": 3, "token": token]), .failure(.off))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["port": 65536, "generation": 3, "token": token]), .failure(.off))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["port": 41234, "generation": 0, "token": token]), .failure(.off))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["port": true, "generation": 3, "token": token]), .failure(.off))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["port": 41234.5, "generation": 3, "token": token]), .failure(.off))
  }

  func testRefusesAMalformedToken() {
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["port": 41234, "generation": 3]), .failure(.unreadable))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["port": 41234, "generation": 3, "token": 7]), .failure(.unreadable))
    for bad in ["", "short", "has space in it 0123456789", "quote\"in-the-token-0123456789", String(repeating: "a", count: 257)] {
      XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["port": 41234, "generation": 3, "token": bad]), .failure(.unreadable), bad)
    }
  }

  func testTheReplyCarriesExactlyPortTokenAndGeneration() throws {
    let reply = DevtoolsEndpoint(port: 1, generation: 2, token: token).reply
    XCTAssertEqual(Set(reply.keys), ["port", "token", "generation"])
    XCTAssertEqual(reply["token"] as? String, token)
  }
}
