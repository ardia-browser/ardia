import XCTest

@testable import ArdiaPluginCore

final class PluginHttpCodecTests: XCTestCase {
  func url(_ text: String) -> URL { URL(string: text)! }

  func parse(_ chunks: [String], method: String = "GET", maxBody: Int = 1 << 16, eof: Bool = false) throws -> PluginHttpResponse {
    var parser = PluginHttpParser(method: method, maxBody: maxBody)
    var done = false
    for chunk in chunks where !done { done = try parser.feed(Data(chunk.utf8)) }
    if !done {
      guard eof else { throw FolderRefusal(reason: "unfinished") }
      try parser.finishAtEOF()
    }
    return parser.response
  }

  func refusal(_ body: () throws -> Any) -> String? {
    do {
      _ = try body()
      return nil
    } catch let refusal as FolderRefusal {
      return refusal.reason
    } catch {
      return "\(error)"
    }
  }

  func testTheRequestNamesTheOriginalHostAndClosesTheConnection() throws {
    let hop = PluginHttpHop(url: url("https://api.example.com:8443/v1/a%20b?q=1&r=%2F"), method: "POST", headers: ["content-type": "application/json", "accept-encoding": "gzip"], body: Data("{}".utf8))
    let text = String(decoding: try XCTUnwrap(PluginHttpCodec.requestBytes(hop)), as: UTF8.self)
    let lines = text.components(separatedBy: "\r\n")
    XCTAssertEqual(lines.first, "POST /v1/a%20b?q=1&r=%2F HTTP/1.1")
    XCTAssertTrue(lines.contains("Host: api.example.com:8443"))
    XCTAssertTrue(lines.contains("content-length: 2"))
    XCTAssertTrue(lines.contains("connection: close"))
    XCTAssertTrue(lines.contains("accept-encoding: identity"))
    XCTAssertFalse(lines.contains("accept-encoding: gzip"))
    XCTAssertTrue(text.hasSuffix("\r\n\r\n{}"))
  }

  func testTheHostHeaderDropsTheDefaultPortAndBracketsIPv6() {
    XCTAssertEqual(PluginHttpCodec.hostHeader(url("https://a.example.com:443/")), "a.example.com")
    XCTAssertEqual(PluginHttpCodec.hostHeader(url("http://A.Example.com./")), "a.example.com")
    XCTAssertEqual(PluginHttpCodec.hostHeader(url("http://[2606:4700::1111]:8080/")), "[2606:4700::1111]:8080")
    XCTAssertEqual(PluginHttpCodec.target(url("https://a.example.com")), "/")
    XCTAssertEqual(PluginHttpCodec.port(of: url("https://a.example.com/")), 443)
    XCTAssertEqual(PluginHttpCodec.port(of: url("http://a.example.com/")), 80)
  }

  func testAContentLengthBodyArrivesInPieces() throws {
    let response = try parse(["HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 11\r\n\r\nhello", " world", "ignored"])
    XCTAssertEqual(response.status, 200)
    XCTAssertEqual(String(decoding: response.body, as: UTF8.self), "hello world")
    XCTAssertEqual(response.joinedHeaders["content-type"], "text/plain")
  }

  func testAChunkedBodyIsDecodedAcrossSplitFrames() throws {
    let wire = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: y\r\n\r\n"
    let pieces = wire.map { String($0) }
    let response = try parse(pieces)
    XCTAssertEqual(String(decoding: response.body, as: UTF8.self), "hello world")
  }

  func testACloseDelimitedBodyEndsAtEOF() throws {
    let response = try parse(["HTTP/1.0 200 OK\r\n\r\nall ", "of it"], eof: true)
    XCTAssertEqual(String(decoding: response.body, as: UTF8.self), "all of it")
  }

  func testACutShortBodyIsAnError() {
    XCTAssertEqual(refusal { try self.parse(["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"], eof: true) }, "the answer was cut short")
    XCTAssertEqual(refusal { try self.parse(["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab"], eof: true) }, "the answer was cut short")
    XCTAssertEqual(refusal { try self.parse(["HTTP/1.1 200"], eof: true) }, "the connection closed before the answer arrived")
  }

  func testHeadAnd204And304HaveNoBody() throws {
    XCTAssertEqual(try parse(["HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n"], method: "HEAD").body, Data())
    XCTAssertEqual(try parse(["HTTP/1.1 204 No Content\r\n\r\n"]).status, 204)
    XCTAssertEqual(try parse(["HTTP/1.1 304 Not Modified\r\nContent-Length: 9\r\n\r\n"]).status, 304)
  }

  func testBodylessAnswersMayNameAContentEncoding() throws {
    let head = try parse(["HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 500\r\n\r\n"], method: "HEAD")
    XCTAssertEqual(head.status, 200)
    XCTAssertEqual(head.body, Data())
    let notModified = try parse(["HTTP/1.1 304 Not Modified\r\nContent-Encoding: gzip\r\nETag: \"v1\"\r\n\r\n"])
    XCTAssertEqual(notModified.status, 304)
    XCTAssertEqual(notModified.body, Data())
    XCTAssertEqual(refusal { try self.parse(["HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 4\r\n\r\nabcd"]) }, "the answer is compressed (gzip), which Ardia doesn't decode")
  }

  func testInterimResponsesAreSkipped() throws {
    let response = try parse(["HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok"])
    XCTAssertEqual(response.status, 201)
    XCTAssertEqual(String(decoding: response.body, as: UTF8.self), "ok")
  }

  func testTheBodyCapHoldsForEveryFraming() {
    let cap = 8
    XCTAssertEqual(refusal { try self.parse(["HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n"], maxBody: cap) }, "the answer is over 0 KB")
    XCTAssertNotNil(refusal { try self.parse(["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n5\r\nworld\r\n0\r\n\r\n"], maxBody: cap) })
    XCTAssertNotNil(refusal { try self.parse(["HTTP/1.1 200 OK\r\n\r\n123456", "789"], maxBody: cap, eof: true) })
    XCTAssertNoThrow(try parse(["HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n12345678"], maxBody: cap))
    XCTAssertNotNil(refusal { try self.parse(["HTTP/1.1 200 OK\r\nContent-Length: \(PluginFetchPolicy.maxResponseBytes + 1)\r\n\r\n"], maxBody: PluginFetchPolicy.maxResponseBytes) })
  }

  func testMalformedAnswersAreRefused() {
    XCTAssertNotNil(refusal { try self.parse(["SSH-2.0-OpenSSH\r\n\r\n"]) })
    XCTAssertNotNil(refusal { try self.parse(["HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n"]) })
    XCTAssertNotNil(refusal { try self.parse(["HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n"]) })
    XCTAssertNotNil(refusal { try self.parse(["HTTP/1.1 200 OK\r\nX-A: 1\r\n folded\r\n\r\n"]) })
    XCTAssertNotNil(refusal { try self.parse(["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n"]) })
    XCTAssertNotNil(refusal { try self.parse(["HTTP/1.1 101 Switching Protocols\r\n\r\n"]) })
    XCTAssertNotNil(refusal { try self.parse(["HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 1\r\n\r\nx"]) })
    XCTAssertNotNil(refusal { try self.parse(["HTTP/1.1 200 OK\r\nX: " + String(repeating: "a", count: PluginHttpCodec.maxHeadBytes + 10)]) })
  }

  func testA303AndAPostOn301Or302BecomeAGetWithoutABody() throws {
    let post = PluginHttpHop(url: url("https://a.example.com/form"), method: "POST", headers: ["content-type": "application/json", "authorization": "x"], body: Data("{}".utf8))
    for status in [301, 302, 303] {
      let next = try PluginHttpCodec.redirect(from: post, status: status, location: "/done#frag").get()
      XCTAssertEqual(next.method, "GET")
      XCTAssertNil(next.body)
      XCTAssertEqual(next.url.absoluteString, "https://a.example.com/done")
      XCTAssertEqual(next.headers, ["authorization": "x"])
    }
    let put = PluginHttpHop(url: url("https://a.example.com/x"), method: "PUT", headers: [:], body: Data("1".utf8))
    XCTAssertEqual(try PluginHttpCodec.redirect(from: put, status: 302, location: "/y").get().method, "PUT")
    XCTAssertEqual(try PluginHttpCodec.redirect(from: put, status: 303, location: "/y").get().method, "GET")
    let head = PluginHttpHop(url: url("https://a.example.com/x"), method: "HEAD", headers: [:], body: nil)
    XCTAssertEqual(try PluginHttpCodec.redirect(from: head, status: 303, location: "/y").get().method, "HEAD")
  }

  func testA307Or308KeepsTheMethodAndBody() throws {
    let post = PluginHttpHop(url: url("https://a.example.com/form"), method: "POST", headers: ["content-type": "text/plain"], body: Data("x".utf8))
    for status in [307, 308] {
      let next = try PluginHttpCodec.redirect(from: post, status: status, location: "https://a.example.com/again").get()
      XCTAssertEqual(next.method, "POST")
      XCTAssertEqual(next.body, Data("x".utf8))
      XCTAssertEqual(next.headers, ["content-type": "text/plain"])
    }
  }

  func testARedirectFromHttpsToPlainHttpIsRefusedForEveryStatus() throws {
    let post = PluginHttpHop(url: url("https://a.example.com/form"), method: "POST", headers: ["content-type": "text/plain"], body: Data("secret".utf8))
    for status in [301, 302, 303, 307, 308] {
      guard case .failure = PluginHttpCodec.redirect(from: post, status: status, location: "http://a.example.com/again") else { return XCTFail("\(status) followed a downgrade") }
    }
    let plain = PluginHttpHop(url: url("http://a.example.com/"), method: "GET", headers: [:], body: nil)
    XCTAssertEqual(try PluginHttpCodec.redirect(from: plain, status: 302, location: "http://b.example.com/").get().url.absoluteString, "http://b.example.com/")
    XCTAssertEqual(try PluginHttpCodec.redirect(from: plain, status: 302, location: "https://b.example.com/").get().url.absoluteString, "https://b.example.com/")
  }

  func testACrossOriginRedirectDropsCredentials() throws {
    let hop = PluginHttpHop(url: url("https://a.example.com/"), method: "GET", headers: ["authorization": "Bearer x", "cookie": "a=b", "accept": "*/*"], body: nil)
    XCTAssertEqual(try PluginHttpCodec.redirect(from: hop, status: 302, location: "https://b.example.com/").get().headers, ["accept": "*/*"])
    XCTAssertEqual(try PluginHttpCodec.redirect(from: hop, status: 302, location: "/same").get().headers, hop.headers)
  }

  func testACrossOriginRedirectThatWouldReplayTheBodyIsRefused() throws {
    let post = PluginHttpHop(url: url("https://a.example.com/form"), method: "POST", headers: ["content-type": "text/plain"], body: Data("secret".utf8))
    for status in [307, 308] {
      XCTAssertNotNil(refusal { try PluginHttpCodec.redirect(from: post, status: status, location: "https://b.example.com/form").get() })
      XCTAssertNotNil(refusal { try PluginHttpCodec.redirect(from: post, status: status, location: "https://a.example.com:8443/form").get() })
      XCTAssertEqual(try PluginHttpCodec.redirect(from: post, status: status, location: "/again").get().body, Data("secret".utf8))
    }
    let moved = try PluginHttpCodec.redirect(from: post, status: 303, location: "https://b.example.com/done").get()
    XCTAssertEqual(moved.method, "GET")
    XCTAssertNil(moved.body)
    let bodiless = PluginHttpHop(url: url("https://a.example.com/x"), method: "DELETE", headers: [:], body: nil)
    XCTAssertEqual(try PluginHttpCodec.redirect(from: bodiless, status: 307, location: "https://b.example.com/x").get().method, "DELETE")
  }

  func feedBytes(_ chunks: [[UInt8]], method: String = "GET") throws -> PluginHttpResponse {
    var parser = PluginHttpParser(method: method, maxBody: 1 << 16)
    var done = false
    for chunk in chunks where !done { done = try parser.feed(Data(chunk)) }
    guard done else { throw FolderRefusal(reason: "unfinished") }
    return parser.response
  }

  func testAnOpaqueByteInAHeaderValueIsKeptInsteadOfFailingTheAnswer() throws {
    let head = Array("HTTP/1.1 200 OK\r\nX-Note: caf".utf8) + [0xe9] + Array("\r\nContent-Length: 2\r\n\r\nok".utf8)
    let response = try feedBytes([head])
    XCTAssertEqual(response.body, Data("ok".utf8))
    XCTAssertEqual(response.values("x-note"), ["caf\u{e9}"])
    XCTAssertEqual(response.values("content-length"), ["2"])
  }

  func testAnOpaqueByteInAFramingOrRedirectHeaderIsRefused() {
    for name in ["Location", "Transfer-Encoding", "Content-Encoding", "Content-Length"] {
      let head = Array("HTTP/1.1 302 Found\r\n\(name): x".utf8) + [0xff] + Array("\r\nContent-Length: 0\r\n\r\n".utf8)
      XCTAssertNotNil(refusal { try self.feedBytes([head]) }, name)
    }
  }

  func testAChunkSizeLineAtTheLimitMayHaveItsCRLFSplitAcrossReads() throws {
    let sizeLine = "2;" + String(repeating: "x", count: PluginHttpCodec.maxChunkLine - 2)
    let head = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
    let whole = try parse([head + sizeLine + "\r\nok\r\n0\r\n\r\n"])
    XCTAssertEqual(whole.body, Data("ok".utf8))
    let split = try parse([head + sizeLine + "\r", "\nok\r\n0\r\n\r\n"])
    XCTAssertEqual(split.body, Data("ok".utf8))
    XCTAssertNotNil(refusal { try self.parse([head + sizeLine + "y\r", "\nok\r\n0\r\n\r\n"]) })
  }

  func testARedirectWithoutAUsableLocationIsRefused() {
    let hop = PluginHttpHop(url: url("https://a.example.com/"), method: "GET", headers: [:], body: nil)
    XCTAssertNotNil(refusal { try PluginHttpCodec.redirect(from: hop, status: 302, location: nil).get() })
    XCTAssertNotNil(refusal { try PluginHttpCodec.redirect(from: hop, status: 302, location: "").get() })
    XCTAssertTrue(PluginHttpCodec.isRedirect(308))
    XCTAssertFalse(PluginHttpCodec.isRedirect(304))
  }

  func testEveryHopIsReVettedAndTheChainStopsAtFive() throws {
    let rules = ["a.example.com"]
    var hop = PluginHttpHop(url: url("https://a.example.com/0"), method: "GET", headers: [:], body: nil)
    for count in 1...PluginFetchPolicy.maxRedirects {
      hop = try PluginHttpCodec.redirect(from: hop, status: 302, location: "/\(count)").get()
      XCTAssertNil(PluginFetchPolicy.checkRedirect(to: hop.url, count: count, allowedHosts: rules, allowLoopback: false))
    }
    XCTAssertNotNil(PluginFetchPolicy.checkRedirect(to: hop.url, count: PluginFetchPolicy.maxRedirects + 1, allowedHosts: rules, allowLoopback: false))
    XCTAssertNotNil(refusal { try PluginHttpCodec.redirect(from: hop, status: 302, location: "http://169.254.169.254/latest").get() })
    let escaped = try PluginHttpCodec.redirect(from: hop, status: 302, location: "https://169.254.169.254/latest").get()
    XCTAssertNotNil(PluginFetchPolicy.checkRedirect(to: escaped.url, count: 1, allowedHosts: ["*"], allowLoopback: false))
    XCTAssertNil(try? PluginFetchPolicy.pinnedAddress(for: url("https://a.example.com/"), resolved: ["10.0.0.1"], allowLoopback: false).get())
  }
}
