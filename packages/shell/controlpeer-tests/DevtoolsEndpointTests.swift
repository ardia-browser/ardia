import ArdiaControlPeerCore
import Darwin
import Foundation
import XCTest

final class DevtoolsEndpointTests: XCTestCase {
  private var scratch: URL!
  private let token = "Canary-DevTools-Token_0123456789abcdefABCDEF"

  override func setUpWithError() throws {
    scratch = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("acd-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: scratch)
  }

  private func write(_ body: [String: Any], mode: mode_t = 0o600, name: String = "ArdiaControl.json") throws -> String {
    let path = scratch.appendingPathComponent(name).path
    try JSONSerialization.data(withJSONObject: body).write(to: URL(fileURLWithPath: path))
    XCTAssertEqual(chmod(path, mode), 0)
    return path
  }

  private func status(_ file: String, port: Int = 41234, generation: Int = 3, state: String = "on") -> [String: Any] {
    ["state": state, "port": port, "generation": generation, "file": file, "connections": 0]
  }

  private func published(port: Int = 41234, generation: Int = 3, pid: Int32 = getpid(), token: String? = nil) -> [String: Any] {
    ["port": port, "generation": generation, "pid": Int(pid), "token": token ?? self.token, "browser": "/x"]
  }

  func testReadsTheTokenOfTheRunningServer() throws {
    let path = try write(published())
    XCTAssertEqual(try DevtoolsEndpoint.read(status: status(path)).get(), DevtoolsEndpoint(port: 41234, generation: 3, token: token))
  }

  func testAnEngineReplyCarriesTheTokenInProcess() throws {
    XCTAssertEqual(try DevtoolsEndpoint.read(engineReply: ["port": 41234, "generation": 3, "token": token]).get(), DevtoolsEndpoint(port: 41234, generation: 3, token: token))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["state": "off"]), .failure(.off))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["error": "profile not loaded"]), .failure(.off))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["port": 41234, "generation": 3, "token": "short"]), .failure(.unreadable))
    XCTAssertEqual(DevtoolsEndpoint.read(engineReply: ["port": 41234, "generation": 3]), .failure(.unreadable))
  }

  func testTheStatusTokenIsNeverTrusted() throws {
    var given = status("/nonexistent/ArdiaControl.json")
    given["token"] = token
    XCTAssertEqual(DevtoolsEndpoint.read(status: given), .failure(.unreadable))
  }

  func testRefusesAFileWhoseAccessListLetsOthersIn() throws {
    let path = try write(published(), name: "acl.json")
    let acl = Process()
    acl.executableURL = URL(fileURLWithPath: "/bin/chmod")
    acl.arguments = ["+a", "everyone allow read", path]
    try acl.run()
    acl.waitUntilExit()
    XCTAssertEqual(acl.terminationStatus, 0)
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(path)), .failure(.unreadable))
  }

  func testAServerThatIsntOnHasNoEndpoint() throws {
    let path = try write(published())
    for state in ["off", "starting", "external"] {
      XCTAssertEqual(DevtoolsEndpoint.read(status: status(path, state: state)), .failure(.off))
    }
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(path, port: 0)), .failure(.off))
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(path, generation: 0)), .failure(.off))
    XCTAssertEqual(DevtoolsEndpoint.read(status: [:]), .failure(.off))
    var boolean = status(path)
    boolean["port"] = true
    XCTAssertEqual(DevtoolsEndpoint.read(status: boolean), .failure(.off))
  }

  func testAFileFromAnotherServerOrProcessIsStale() throws {
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(try write(published(generation: 2)))), .failure(.stale))
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(try write(published(port: 41235)))), .failure(.stale))
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(try write(published(pid: getpid() + 1)))), .failure(.stale))
  }

  func testRefusesAFileOthersCanReadALinkOrAFolder() throws {
    let open = try write(published(), mode: 0o644, name: "open.json")
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(open)), .failure(.unreadable))
    let real = try write(published(), name: "real.json")
    let link = scratch.appendingPathComponent("link.json").path
    XCTAssertEqual(symlink(real, link), 0)
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(link)), .failure(.unreadable))
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(scratch.path)), .failure(.unreadable))
    XCTAssertEqual(DevtoolsEndpoint.read(status: status("relative/ArdiaControl.json")), .failure(.unreadable))
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(scratch.appendingPathComponent("missing.json").path)), .failure(.unreadable))
  }

  func testRefusesAMalformedOrOversizedFile() throws {
    let garbage = scratch.appendingPathComponent("garbage.json").path
    try Data("{not json".utf8).write(to: URL(fileURLWithPath: garbage))
    XCTAssertEqual(chmod(garbage, 0o600), 0)
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(garbage)), .failure(.unreadable))
    let big = scratch.appendingPathComponent("big.json").path
    try Data(repeating: 0x20, count: DevtoolsEndpoint.maxFileBytes + 1).write(to: URL(fileURLWithPath: big))
    XCTAssertEqual(chmod(big, 0o600), 0)
    XCTAssertEqual(DevtoolsEndpoint.read(status: status(big)), .failure(.unreadable))
    for bad in ["", "has space in it 0123456789", "quote\"in-the-token-0123456789", String(repeating: "a", count: 257)] {
      XCTAssertEqual(DevtoolsEndpoint.read(status: status(try write(published(token: bad), name: "bad.json"))), .failure(.unreadable), bad)
    }
  }

  func testTheReplyCarriesExactlyPortTokenAndGeneration() throws {
    let reply = DevtoolsEndpoint(port: 1, generation: 2, token: token).reply
    XCTAssertEqual(Set(reply.keys), ["port", "token", "generation"])
    XCTAssertEqual(reply["token"] as? String, token)
  }
}
