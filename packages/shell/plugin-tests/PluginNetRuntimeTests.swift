import XCTest

@testable import ArdiaPluginCore

final class PluginNetRuntimeTests: XCTestCase {
  func testUtf8ChunksNeverSplitACharacterAcrossEvents() {
    let text = "héllo 🙂 wörld"
    let bytes = Data(text.utf8)
    for cut in 0...bytes.count {
      var chunks = PluginUtf8Chunks()
      let joined = chunks.text(bytes.prefix(cut)) + chunks.text(bytes.suffix(from: cut)) + chunks.finish()
      XCTAssertEqual(joined, text, "cut at \(cut)")
    }
    var chunks = PluginUtf8Chunks()
    XCTAssertEqual(chunks.text(Data([0xF0, 0x9F])), "")
    XCTAssertEqual(chunks.text(Data([0x99, 0x82])), "🙂")
  }

  func testAStreamedBodyDrainsInPiecesAndKeepsItsTotalCap() throws {
    var parser = PluginHttpParser(method: "GET", maxBody: 12)
    XCTAssertFalse(try parser.feed(Data("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n4\r\ndata\r\n".utf8)))
    XCTAssertTrue(parser.headReady)
    XCTAssertEqual(parser.drainBody(), Data("data".utf8))
    XCTAssertFalse(try parser.feed(Data("4\r\nmore\r\n".utf8)))
    XCTAssertEqual(parser.drainBody(), Data("more".utf8))
    XCTAssertEqual(parser.bodyTotal, 8)
    XCTAssertThrowsError(try parser.feed(Data("5\r\ntoo-much\r\n".utf8)))
  }

  func testPkceSignInBuildsTheAuthorizeAddressAndChecksTheCallback() throws {
    let made = PluginAuthRequest.make(
      authorize: "https://auth.example.com/authorize?audience=x&state=evil", clientId: "client-1", scopes: ["read", "write"], scope: "alice", name: "github-auth",
      extra: ["prompt": "consent"], state: "s1", verifier: "v1")
    let request = try made.get()
    let items = URLComponents(url: request.authorizeURL, resolvingAgainstBaseURL: false)!.queryItems!
    let value = { (name: String) in items.filter { $0.name == name }.map(\.value) }
    XCTAssertEqual(value("state"), ["s1"])
    XCTAssertEqual(value("audience"), ["x"])
    XCTAssertEqual(value("code_challenge_method"), ["S256"])
    XCTAssertEqual(value("code_challenge"), [PluginAuthRequest.challenge(for: "v1")])
    XCTAssertEqual(value("redirect_uri"), ["ardia-auth://alice/github-auth/callback"])
    XCTAssertEqual(value("scope"), ["read write"])
    XCTAssertEqual(PluginAuthRequest.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    XCTAssertEqual(try request.code(from: URL(string: "ardia-auth://alice/github-auth/callback?code=abc&state=s1")!).get(), "abc")
    XCTAssertThrowsError(try request.code(from: URL(string: "ardia-auth://alice/github-auth/callback?code=abc&state=s2")!).get())
    XCTAssertThrowsError(try request.code(from: URL(string: "ardia-auth://mallory/github-auth/callback?code=abc&state=s1")!).get())
    XCTAssertThrowsError(try request.code(from: URL(string: "ardia-auth://alice/github-auth/callback?code=abc&code=def&state=s1")!).get())
    XCTAssertThrowsError(try request.code(from: URL(string: "ardia-auth://alice/github-auth/callback?error=access_denied&state=s1")!).get())
    XCTAssertThrowsError(try PluginAuthRequest.make(authorize: "http://auth.example.com/", clientId: "c", scopes: [], scope: "a", name: "b", extra: [:], state: "s", verifier: "v").get())
    XCTAssertThrowsError(try PluginAuthRequest.make(authorize: "https://auth.example.com/", clientId: "c", scopes: [], scope: "a", name: "b", extra: ["redirect_uri": "x"], state: "s", verifier: "v").get())
    XCTAssertNotNil(PluginAuthRequest.randomToken())
  }
}

final class PluginUsageTests: XCTestCase {
  func testUsageSamplesALiveProcessAndRefusesADeadOne() {
    let first = PluginUsage.sample(getpid())
    XCTAssertNotNil(first)
    XCTAssertGreaterThan(first?.memoryBytes ?? 0, 0)
    var spin = 0
    for i in 0..<2_000_000 { spin &+= i }
    XCTAssertNotEqual(spin, -1)
    XCTAssertGreaterThanOrEqual(PluginUsage.sample(getpid())?.cpuNanos ?? 0, first?.cpuNanos ?? 0)
    XCTAssertNil(PluginUsage.sample(0))
  }
}

final class PluginBoundedFileTests: XCTestCase {
  func testABoundedReadRefusesLinksDirectoriesAndOversizedFiles() throws {
    let folder = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("bounded-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let file = folder.appendingPathComponent("a.txt")
    try Data("hello world".utf8).write(to: file)
    let link = folder.appendingPathComponent("link.txt")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
    guard case .success(let opened) = PluginBoundedFile.openRegular(file.path) else { return XCTFail("a regular file opens") }
    defer { Darwin.close(opened.fd) }
    XCTAssertEqual(opened.size, 11)
    XCTAssertEqual(PluginBoundedFile.readWhole(opened.fd, max: 11), Data("hello world".utf8))
    XCTAssertNil(PluginBoundedFile.readWhole(opened.fd, max: 10), "one byte over the cap is refused, read from the open descriptor")
    XCTAssertEqual(PluginBoundedFile.read(opened.fd, offset: 6, length: 100), Data("world".utf8))
    if case .success = PluginBoundedFile.openRegular(link.path) { XCTFail("a link is refused") }
    if case .success = PluginBoundedFile.openRegular(folder.path) { XCTFail("a folder is refused") }
  }
}

final class ControlLineBudgetTests: XCTestCase {
  func testASidecarPipeTakesAnyNumberOfRepliesAndEventsWhileRequestsStayBounded() {
    var sidecar = ControlLineBudget(mode: .messages, limit: 32)
    for _ in 0..<120 { XCTAssertTrue(sidecar.received()) }
    XCTAssertTrue(sidecar.settled)
    var requests = ControlLineBudget(mode: .requests, limit: 32)
    for _ in 0..<32 { XCTAssertTrue(requests.received()) }
    XCTAssertFalse(requests.received(), "the 33rd unanswered request retires a request pipe")
    var answered = ControlLineBudget(mode: .requests, limit: 32)
    for _ in 0..<60 {
      XCTAssertTrue(answered.received())
      answered.answered()
    }
    XCTAssertTrue(answered.settled)
  }
}

final class PluginWebSocketCodecTests: XCTestCase {
  func testTheHandshakeTargetsTheOriginalHostAndChecksTheServersAccept() throws {
    let url = URL(string: "https://chat.example.com:8443/live?room=1")!
    let key = "dGhlIHNhbXBsZSBub25jZQ=="
    let request = String(decoding: PluginWebSocketCodec.handshake(url: url, key: key, protocols: ["chat"], headers: [("authorization", "Bearer x")])!, as: UTF8.self)
    XCTAssertTrue(request.hasPrefix("GET /live?room=1 HTTP/1.1\r\nHost: chat.example.com:8443\r\n"))
    XCTAssertTrue(request.contains("Sec-WebSocket-Protocol: chat\r\n"))
    XCTAssertNil(PluginWebSocketCodec.handshake(url: url, key: key, protocols: [], headers: [("cookie", "a")]))
    XCTAssertNil(PluginWebSocketCodec.handshake(url: url, key: key, protocols: [], headers: [("x", "a\r\nb")]))
    XCTAssertEqual(PluginWebSocketCodec.accept(for: key), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    let good = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\nSec-WebSocket-Protocol: chat\r\n\r\n"
    XCTAssertEqual(try PluginWebSocketCodec.checkHandshake(Data(good.utf8), key: key, protocols: ["chat"]).get(), "chat")
    XCTAssertThrowsError(try PluginWebSocketCodec.checkHandshake(Data(good.utf8), key: "other", protocols: ["chat"]).get())
    XCTAssertThrowsError(try PluginWebSocketCodec.checkHandshake(Data(good.replacingOccurrences(of: "101", with: "200").utf8), key: key, protocols: ["chat"]).get())
    XCTAssertThrowsError(try PluginWebSocketCodec.checkHandshake(Data(good.utf8), key: key, protocols: []).get(), "a protocol the plugin didn't offer")
  }

  func testFramesRoundTripAndTheParserRefusesMaskedOversizedAndBrokenFrames() throws {
    let framed = PluginWebSocketCodec.frame(opcode: 0x1, payload: Data("hi".utf8), mask: [1, 2, 3, 4])
    XCTAssertEqual([UInt8](framed.prefix(2)), [0x81, 0x82])
    var parser = PluginWebSocketParser(maxPayload: 8)
    XCTAssertEqual(try parser.feed(Data([0x81, 0x02, 0x68])), [])
    XCTAssertEqual(try parser.feed(Data([0x69, 0x01, 0x03, 0x61, 0x62, 0x63, 0x80, 0x01, 0x64, 0x89, 0x00])), [.text(Data("hi".utf8)), .text(Data("abcd".utf8)), .ping(Data())])
    XCTAssertEqual(try parser.feed(Data([0x88, 0x02, 0x03, 0xe8])), [.close(code: 1000, reason: "")])
    var masked = PluginWebSocketParser(maxPayload: 8)
    XCTAssertThrowsError(try masked.feed(framed))
    var big = PluginWebSocketParser(maxPayload: 8)
    XCTAssertThrowsError(try big.feed(Data([0x82, 0x09] + [UInt8](repeating: 0, count: 9))))
    var stray = PluginWebSocketParser(maxPayload: 8)
    XCTAssertThrowsError(try stray.feed(Data([0x80, 0x01, 0x61])))
  }

  func testASocketTargetIsVettedBeforeAnyConnectionOpens() {
    XCTAssertNotNil(PluginFetchPolicy.check(URL(string: "https://10.0.0.5/")!, allowedHosts: ["*"]))
    XCTAssertNotNil(PluginFetchPolicy.check(URL(string: "http://127.0.0.1:9/")!, allowedHosts: ["*"]))
    XCTAssertNotNil(PluginFetchPolicy.check(URL(string: "https://evil.example/")!, allowedHosts: ["chat.example.com"]))
    XCTAssertThrowsError(try PluginFetchPolicy.vettedAddresses(for: URL(string: "https://chat.example.com/")!, resolved: ["192.168.1.4"], allowLoopback: false).get())
    XCTAssertThrowsError(try PluginFetchPolicy.vettedAddresses(for: URL(string: "https://chat.example.com/")!, resolved: ["93.184.216.34", "::1"], allowLoopback: false).get(), "one private answer refuses the whole name")
    XCTAssertEqual(try PluginFetchPolicy.vettedAddresses(for: URL(string: "https://chat.example.com/")!, resolved: ["93.184.216.34"], allowLoopback: false).get(), ["93.184.216.34"])
  }
}
